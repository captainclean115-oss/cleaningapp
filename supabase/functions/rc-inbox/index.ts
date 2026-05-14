// Edge Function: rc-inbox
//
// Server-side SMS inbox reader. Replaces the browser-side
// `loadInbox` + `rcFetchAllPages` + `rcFetch` chain in index.html
// (lines ~30413, ~30383, ~27917 — the entire client-side RC
// message-store path). With this in place, the browser never holds
// an RC access token or refresh token — credentials live in
// public.business_phone_integrations and the OAuth refresh dance
// happens here, server-side, exactly like send-sms does for outbound.
//
// Per call: 1 RC OAuth refresh + up to 20 paginated GETs against
// /account/~/extension/~/message-store?messageType=SMS&dateFrom=…
// (perPage=250 → max 5000 records). The browser-side path was
// debounced 30s and polled every 2 minutes; the client should
// preserve those cadences when calling this function. The 60/hour
// rate limit gives ~30 polled refreshes per hour with headroom for
// tab-open + send-then-refresh + retry-on-throttle bursts.
//
// Deploy:
//   supabase functions deploy rc-inbox --project-ref wymoezilyjmyibmuqqmr
//
// Required secrets (only while at least one tenant uses env-source —
// same set as send-sms):
//   RC_CLIENT_ID, RC_CLIENT_SECRET, RC_REFRESH_TOKEN
//
// Response shape:
//   { messages: [<projected message>], partial?: boolean, retryAfter?: number }
// Each projected message has exactly these fields (every other RC
// field is dropped to keep the response surface tight + avoid leaking
// fields the UI doesn't consume):
//   { id, direction, from:{phoneNumber,name},
//     to:[{phoneNumber,name}], creationTime, subject, body, readStatus }
//
// `partial: true` + `retryAfter` is set when RC throttles us mid-
// pagination. The client should treat this as a soft failure: render
// whatever messages came back, then schedule a retry after `retryAfter`
// seconds (mirrors the browser-side 429 handling at index.html:30437).

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Read the project's "public" client key. Supabase migrated this project
// from the legacy anon-key JWT format to the new publishable-key format.
// Try the new env var first, fall back to the legacy one, fail loudly
// if neither is set.
const ANON_KEY =
  Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ||
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
  Deno.env.get("SUPABASE_ANON_KEY") ||
  "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_PUBLISHABLE_KEYS / SUPABASE_PUBLISHABLE_KEY / SUPABASE_ANON_KEY env var");
// Service-role key for the privileged client used to look up integration
// rows. Mirrors send-sms's pattern exactly.
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

interface RcCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

async function rcAccessToken(creds: RcCreds): Promise<string> {
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  const resp = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refreshToken)}`,
  });
  if (!resp.ok) {
    throw new Error(`RC OAuth refresh failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error("RC OAuth returned no access_token");
  return data.access_token as string;
}

// Projection: keep only the 7 fields the UI consumes (per the
// inventory in 2026-05-14's audit). Drops attachments, threadId,
// segmentCount, availability, conversationId, and ~25 other fields.
interface ProjectedMessage {
  id:           string;
  direction:    "Inbound" | "Outbound";
  from:         { phoneNumber: string; name: string | null };
  to:           Array<{ phoneNumber: string; name: string | null }>;
  creationTime: string;
  subject:      string | null;
  body:         string | null;
  readStatus:   "Read" | "Unread";
}

function projectMessage(raw: Record<string, unknown>): ProjectedMessage {
  const fromRaw = (raw.from as Record<string, unknown> | undefined) || undefined;
  const toRawArr = Array.isArray(raw.to) ? (raw.to as Array<Record<string, unknown>>) : [];
  return {
    id:           String(raw.id || ""),
    direction:    raw.direction === "Outbound" ? "Outbound" : "Inbound",
    from:         {
      phoneNumber: fromRaw ? String(fromRaw.phoneNumber || "") : "",
      name:        fromRaw && fromRaw.name != null ? String(fromRaw.name) : null,
    },
    to:           toRawArr.map((t) => ({
      phoneNumber: String(t.phoneNumber || ""),
      name:        t.name != null ? String(t.name) : null,
    })),
    creationTime: String(raw.creationTime || ""),
    subject:      raw.subject != null ? String(raw.subject) : null,
    body:         raw.body    != null ? String(raw.body)    : null,
    readStatus:   raw.readStatus === "Unread" ? "Unread" : "Read",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  // Step 1: caller auth + tenant resolution. Mirrors send-sms.
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

  // Rate limit: 60/hour per user (single window). Inbox reads are
  // cheap on RC's side but each call here does up to 20 paginated
  // GETs + 1 OAuth refresh, so we cap higher than the SMS-send
  // outbound limit isn't justified — 60/hr gives ~1/min headroom
  // for a manager who keeps the Messages tab open (browser was 2-min
  // polled = 30/hr) with burst budget for retries + tab re-opens.
  // Fail-open on RPC error.
  const rateKey = `rc-inbox:${callerAuthId}`;
  const { data: rateOk, error: rateErr } = await admin.rpc("check_rate_limit", {
    p_key:            rateKey,
    p_max_calls:      60,
    p_window_seconds: 3600,
  });
  if (rateErr) {
    console.error("[rc-inbox] rate limit RPC failed:", rateErr);
    // Fail-open — don't block real refreshes on a transient DB issue.
  } else if (rateOk === false) {
    return json(429, {
      error: "Rate limit exceeded",
      hint:  "60/hour inbox refresh limit reached. Wait before retrying.",
    });
  }

  // Step 2: parse optional payload. Default 6 months back, clamp 1-12.
  let payload: { months_back?: number } = {};
  if (req.headers.get("Content-Length") && req.headers.get("Content-Length") !== "0") {
    try { payload = await req.json(); } catch { /* empty body OK */ }
  }
  let monthsBack = Number(payload.months_back);
  if (!Number.isFinite(monthsBack)) monthsBack = 6;
  monthsBack = Math.max(1, Math.min(12, Math.floor(monthsBack)));
  const dateFromIso = new Date(Date.now() - monthsBack * 30 * 86400 * 1000).toISOString();

  // Step 3: resolve this tenant's RC integration. Same RPC + same
  // error shape as send-sms so the client sees a consistent 424.
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

  // Step 4: resolve credentials. Env-source means "use the platform
  // env vars" (Manna Maids' transitional state). Otherwise read
  // straight from the JSONB. Same shape as send-sms.
  const credsJson = (integRow.credentials || {}) as Record<string, unknown>;
  let creds: RcCreds;
  if (credsJson.source === "env") {
    creds = {
      clientId:     ENV_RC_CLIENT_ID,
      clientSecret: ENV_RC_CLIENT_SECRET,
      refreshToken: ENV_RC_REFRESH_TOKEN,
    };
  } else {
    creds = {
      clientId:     String(credsJson.client_id     || ""),
      clientSecret: String(credsJson.client_secret || ""),
      refreshToken: String(credsJson.refresh_token || ""),
    };
  }
  for (const k of ["clientId", "clientSecret", "refreshToken"] as const) {
    if (!creds[k]) {
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `Missing credential field: ${k}`,
      });
      return json(500, { error: `Integration credentials incomplete (missing ${k})` });
    }
  }

  // Step 5: get RC access token. Refresh failure → 401 (the only
  // recoverable action for the user is for an admin to re-paste a
  // fresh refresh_token; we can't recover client-side because there
  // is no client-side token to clear).
  let accessToken: string;
  try {
    accessToken = await rcAccessToken(creds);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await admin.rpc("mark_phone_integration_error", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
      p_error:       msg,
    });
    return json(401, {
      error: "RC OAuth refresh failed",
      hint:  "Have an owner/admin re-paste a fresh refresh_token in Settings → Phone & SMS.",
      detail: msg,
    });
  }

  // Step 6: paginate /message-store. Mirrors index.html's
  // rcFetchAllPages exactly — perPage 250, 20-page hard cap, follow
  // navigation.nextPage.uri stripping the base URL.
  const initialQuery = `?messageType=SMS&dateFrom=${encodeURIComponent(dateFromIso)}&perPage=250&page=1`;
  let nextPath: string | null = `/account/~/extension/~/message-store${initialQuery}`;
  const collected: Array<Record<string, unknown>> = [];
  let pageCount = 0;
  let partial = false;
  let retryAfterSec: number | undefined = undefined;

  while (nextPath && pageCount < 20) {
    pageCount++;
    let pageResp: Response;
    try {
      pageResp = await fetch(RC_BASE + nextPath, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `RC message-store fetch threw: ${msg}`,
      });
      return json(502, { error: "RC inbox fetch failed", detail: msg });
    }

    // 429 mid-pagination: return what we have + partial flag.
    if (pageResp.status === 429) {
      const ra = parseInt(pageResp.headers.get("Retry-After") || "60", 10);
      retryAfterSec = Number.isFinite(ra) && ra > 0 ? ra : 60;
      partial = true;
      console.warn("[rc-inbox] 429 throttled mid-pagination — partial result");
      break;
    }

    if (!pageResp.ok) {
      const detail = await pageResp.text();
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `RC message-store ${pageResp.status}: ${detail.slice(0, 200)}`,
      });
      return json(502, { error: "RC inbox fetch failed", status: pageResp.status, detail });
    }

    let pageData: Record<string, unknown>;
    try {
      pageData = await pageResp.json();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `RC message-store JSON parse failed: ${msg}`,
      });
      return json(502, { error: "RC inbox parse failed", detail: msg });
    }

    const records = Array.isArray(pageData.records) ? (pageData.records as Array<Record<string, unknown>>) : [];
    if (records.length === 0) break;
    for (const r of records) collected.push(r);

    // Follow nextPage.uri exactly as the browser code did.
    const navigation = (pageData.navigation as Record<string, unknown> | undefined) || undefined;
    const nextPage = navigation && (navigation.nextPage as Record<string, unknown> | undefined);
    const nextUri  = nextPage && typeof nextPage.uri === "string" ? (nextPage.uri as string) : null;
    if (nextUri && records.length >= 250) {
      nextPath = nextUri.replace("https://platform.ringcentral.com/restapi/v1.0", "");
    } else {
      nextPath = null;
    }
  }

  // Step 7: project + return. Mark integration used on success.
  const messages = collected.map(projectMessage);
  await admin.rpc("mark_phone_integration_used", {
    p_business_id: businessId,
    p_provider:    "ringcentral",
  });
  return json(200, partial ? { messages, partial: true, retryAfter: retryAfterSec } : { messages });
});
