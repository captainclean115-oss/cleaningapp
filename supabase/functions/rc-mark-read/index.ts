// Edge Function: rc-mark-read
//
// Marks a single RingCentral SMS message as read. Replaces the
// browser-side rcFetch call at index.html line 30620 which did:
//   rcFetch('/account/~/extension/~/message-store/<msgId>',
//           { method: 'PUT', body: { readStatus: 'Read' } })
//
// With this in place, the browser never holds an RC access token —
// credentials live in public.business_phone_integrations and the
// OAuth refresh dance happens server-side, exactly like send-sms +
// rc-inbox do.
//
// Phase 1 SMS strategy (mig 062) — JWT bearer-grant auth alongside
// the existing OAuth refresh-token flow. Branches on
// credentials.auth_method ('oauth' | 'jwt'); missing/unknown defaults
// to 'oauth'. Identical pattern to send-sms.
//
// Per call: 1 RC OAuth refresh + 1 PUT against
// /account/~/extension/~/message-store/<msgId>. The browser code
// fired one of these per unread message when a conversation opened,
// so a thread with 20 unread messages = 20 sequential calls. Rate
// limit is sized accordingly (600/hour gives 30 thread-opens-of-20
// in a single hour, which is well above legitimate use).
//
// Deploy:
//   supabase functions deploy rc-mark-read --project-ref wymoezilyjmyibmuqqmr
//
// Required secrets (only while at least one tenant uses env-source —
// same set as send-sms / rc-inbox):
//   RC_CLIENT_ID, RC_CLIENT_SECRET, RC_REFRESH_TOKEN
//
// Request shape:
//   POST { message_id: string }           // numeric string, 1-32 chars
// Response shape:
//   200  { ok: true }                     // marked read
//   400  { error: "..." }                 // bad payload / bad id format
//   401  { error: "..." }                 // missing/invalid JWT or OAuth refresh failed
//   403  { error: "No tenant for caller" }
//   404  { error: "Message not found" }   // RC said the id doesn't exist
//   424  { error: "...", hint: "..." }    // no RC integration configured
//   429  { error: "...", retryAfter? }    // rate limit (ours) OR RC throttle
//   502  { error: "...", detail: "..." }  // other RC API failure

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Read the project's "public" client key. Supabase migrated this project
// from the legacy anon-key JWT format to the new publishable-key format.
// Try the new env var first, fall back to the legacy one, fail loudly
// if neither is set.
// SUPABASE_ANON_KEY is set by Supabase to the project's current
// browser-facing key (sb_publishable_* format in the new key system,
// or the legacy JWT in older projects). Use it directly. The plural
// SUPABASE_PUBLISHABLE_KEYS env var contains a JSON object of multiple
// named keys and is NOT a direct drop-in for createClient.
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY env var");
// Service-role key for the privileged client used to look up integration
// rows. Mirrors send-sms / rc-inbox.
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Legacy env-source fallbacks. Used only when the integration row's
// credentials JSONB is {"source":"env"}.
const ENV_RC_CLIENT_ID     = Deno.env.get("RC_CLIENT_ID")     || "";
const ENV_RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET") || "";
const ENV_RC_REFRESH_TOKEN = Deno.env.get("RC_REFRESH_TOKEN") || "";
const ENV_RC_FROM_NUMBER   = Deno.env.get("RC_FROM_NUMBER")   || "";

const RC_BASE = "https://platform.ringcentral.com/restapi/v1.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type RcAuthMethod = "oauth" | "jwt";

interface RcCreds {
  authMethod:    RcAuthMethod;
  clientId:      string;
  clientSecret:  string;
  refreshToken?: string;
  jwtCredential?: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function rcAccessToken(creds: RcCreds): Promise<string> {
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  let body: string;
  if (creds.authMethod === "jwt") {
    if (!creds.jwtCredential) throw new Error("JWT credential missing");
    body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}`
         + `&assertion=${encodeURIComponent(creds.jwtCredential)}`;
  } else {
    if (!creds.refreshToken) throw new Error("OAuth refresh_token missing");
    body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refreshToken)}`;
  }
  const resp = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!resp.ok) {
    const flow = creds.authMethod === "jwt" ? "JWT bearer-grant" : "OAuth refresh";
    throw new Error(`RC ${flow} failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error("RC returned no access_token");
  return data.access_token as string;
}

async function getCachedRcAccessToken(businessId: string, creds: RcCreds): Promise<string> {
  const cacheKey = `${businessId}:${creds.authMethod}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;
  const token = await rcAccessToken(creds);
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
  return token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  // Step 1: caller auth + tenant resolution. Mirrors rc-inbox.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });

  // Extract the bearer token. Use the explicit form of auth.getUser(jwt)
  // because the global-headers form interacts poorly with the new
  // publishable-key system.
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Empty bearer token" });

  const caller = createClient(SUPABASE_URL, ANON_KEY);
  const { data: callerData, error: callerErr } = await caller.auth.getUser(jwt);
  if (callerErr) {
    console.error("[auth] getUser failed:", callerErr.message, callerErr);
    return json(401, { error: "Invalid JWT", detail: callerErr.message });
  }
  if (!callerData.user) return json(401, { error: "Invalid JWT (no user)" });
  const callerAuthId = callerData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userRow = await admin.from("users").select("business_id").eq("id", callerAuthId).maybeSingle();
  const businessId = userRow.data?.business_id;
  if (!businessId) return json(403, { error: "No tenant for caller" });

  // Rate limit (security audit 3b): 300/hr per user, split check/inc.
  // Tightened from 600/hr — still supports 15 thread-opens-of-20
  // per hour which is well above legitimate use. Failed marks
  // (caller-bug 404, RC 429 throttle) don't consume budget since
  // increment is post-success.
  const userRateKey = `user:${callerAuthId}:rc-mark-read`;
  const USER_LIMIT  = 300;
  const checkRes = await admin.rpc("rate_limit_check", {
    p_key: userRateKey, p_max: USER_LIMIT, p_window_seconds: 3600,
  });
  if (checkRes.error) {
    console.error("[rc-mark-read] rate_limit_check failed:", checkRes.error);
  } else if (checkRes.data === false) {
    return json(429, {
      error:  "rate_limit_exceeded",
      detail: `Per-user limit ${USER_LIMIT}/hr exceeded for rc-mark-read`,
    });
  }

  // Step 2: parse + validate payload. message_id must be a string of
  // 1-32 digits. RC message ids are numeric; the strict regex blocks
  // a caller from passing an arbitrary path segment (e.g. ".." or
  // "abc/extension/~/sms") that could redirect the PUT.
  let payload: { message_id?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const messageId = payload?.message_id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return json(400, { error: "Missing or empty message_id" });
  }
  if (!/^\d{1,32}$/.test(messageId)) {
    return json(400, { error: "message_id must be 1-32 digits" });
  }

  // Step 3: resolve this tenant's RC integration.
  const integ = await admin.rpc("get_active_phone_integration", {
    p_business_id: businessId,
    p_provider:    "ringcentral",
  });
  const integRow = (integ.data && integ.data[0]) || null;
  if (!integRow) {
    return json(424, {
      error: "No active RingCentral integration configured for this tenant",
      hint:  "Add a row to business_phone_integrations or have an owner/admin set it up in Settings.",
    });
  }

  // Step 4: resolve credentials. Env-source = always OAuth. Otherwise
  // branch on credentials.auth_method: 'jwt' uses JWT bearer-grant,
  // anything else uses the legacy OAuth refresh-token path. Mirrors
  // send-sms and rc-inbox exactly.
  const credsJson = (integRow.credentials || {}) as Record<string, unknown>;
  let creds: RcCreds;
  let requiredFields: ReadonlyArray<"clientId" | "clientSecret" | "refreshToken" | "jwtCredential">;
  if (credsJson.source === "env") {
    creds = {
      authMethod:   "oauth",
      clientId:     ENV_RC_CLIENT_ID,
      clientSecret: ENV_RC_CLIENT_SECRET,
      refreshToken: ENV_RC_REFRESH_TOKEN,
    };
    requiredFields = ["clientId", "clientSecret", "refreshToken"] as const;
  } else if (credsJson.auth_method === "jwt") {
    creds = {
      authMethod:    "jwt",
      clientId:      String(credsJson.client_id      || ""),
      clientSecret:  String(credsJson.client_secret  || ""),
      jwtCredential: String(credsJson.jwt_credential || ""),
    };
    requiredFields = ["clientId", "clientSecret", "jwtCredential"] as const;
  } else {
    creds = {
      authMethod:   "oauth",
      clientId:     String(credsJson.client_id     || ""),
      clientSecret: String(credsJson.client_secret || ""),
      refreshToken: String(credsJson.refresh_token || ""),
    };
    requiredFields = ["clientId", "clientSecret", "refreshToken"] as const;
  }
  for (const k of requiredFields) {
    if (!creds[k]) {
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `Missing credential field: ${k} (auth_method=${creds.authMethod})`,
      });
      return json(500, {
        error: `Integration credentials incomplete (missing ${k} for auth_method=${creds.authMethod})`,
      });
    }
  }

  // Step 5: get RC access token. Refresh failure → 401 (same as rc-inbox).
  let accessToken: string;
  try {
    accessToken = await getCachedRcAccessToken(businessId, creds);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await admin.rpc("mark_phone_integration_error", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
      p_error:       msg,
    });
    return json(401, {
      error: "RC token acquisition failed",
      hint:  "Have an owner/admin re-paste a fresh refresh_token or JWT credential in Settings → Phone & SMS.",
      detail: msg,
    });
  }

  // Step 6: PUT the readStatus update.
  let putResp: Response;
  try {
    putResp = await fetch(`${RC_BASE}/account/~/extension/~/message-store/${messageId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ readStatus: "Read" }),
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await admin.rpc("mark_phone_integration_error", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
      p_error:       `RC mark-read fetch threw: ${msg}`,
    });
    return json(502, { error: "RC mark-read failed", detail: msg });
  }

  // 404: caller bug (message id doesn't exist for this account).
  // No integration-error row — credentials are fine.
  if (putResp.status === 404) {
    return json(404, { error: "Message not found" });
  }

  // 429: RC throttled. Pass retryAfter through.
  if (putResp.status === 429) {
    const ra = parseInt(putResp.headers.get("Retry-After") || "60", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 60;
    console.warn("[rc-mark-read] RC 429 throttled — retryAfter", retryAfter);
    return json(429, { error: "RC rate limit", retryAfter });
  }

  if (!putResp.ok) {
    const detail = await putResp.text();
    await admin.rpc("mark_phone_integration_error", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
      p_error:       `RC mark-read ${putResp.status}: ${detail.slice(0, 200)}`,
    });
    return json(502, { error: "RC mark-read failed", status: putResp.status, detail });
  }

  await admin.rpc("mark_phone_integration_used", {
    p_business_id: businessId,
    p_provider:    "ringcentral",
  });
  // mig 066: increment rate-limit only on success.
  await admin.rpc("rate_limit_increment", { p_key: userRateKey, p_window_seconds: 3600 });
  return json(200, { ok: true });
});
