// Edge Function: send-sms
//
// v11.0.2 (Item B) — per-tenant phone provider integrations.
// Phase 1 SMS strategy (mig 062) — JWT bearer-grant auth alongside
// the existing OAuth refresh-token flow. Branches on
// credentials.auth_method ('oauth' | 'jwt'); missing/unknown defaults
// to 'oauth' so every existing row keeps working.
//
// Server-side SMS sender. Resolves the caller's tenant from JWT, looks
// up that tenant's business_phone_integrations row, and uses its
// credentials + outbound number.
//
// Auth flows:
//   oauth: POST /oauth/token  grant_type=refresh_token
//          (rotates refresh_token on every call — fragile if any other
//           client is also refreshing the same row concurrently)
//   jwt:   POST /oauth/token  grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
//          (long-lived signed JWT assertion, no rotation, safe under
//           concurrent refreshes from multiple Edge Function instances)
//
// Access tokens are cached in-memory per (businessId,authMethod) for
// 50min (RC tokens last ~60min). Cache is per-Edge-Function-instance,
// not global; warms within a single instance's lifetime.
//
// Migration-safe fallback: when an integration row's credentials JSONB
// has `{"source":"env"}` (Manna Maids' transitional state during the
// v11.0.2 migration), the function reads from the existing
// RC_CLIENT_ID / RC_CLIENT_SECRET / RC_REFRESH_TOKEN env vars. Env-source
// is always treated as OAuth (no env-side JWT path).
//
// Deploy:
//   supabase functions deploy send-sms --project-ref wymoezilyjmyibmuqqmr
//
// Required secrets (only while at least one tenant uses env-source):
//   RC_CLIENT_ID, RC_CLIENT_SECRET, RC_REFRESH_TOKEN
// RC_FROM_NUMBER env was previously authoritative; now the from-number
// comes from the integration row's phone_number_e164 column. Env var
// becomes a last-ditch fallback only.

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
// rows. The lookup goes through SECURITY DEFINER RPC, but the client
// invoking the RPC needs to be authenticated — service_role bypasses
// the authenticated-user requirement entirely.
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Legacy env-source fallbacks. Used only when integrations row's
// credentials JSONB is {"source":"env"}.
const ENV_RC_CLIENT_ID     = Deno.env.get("RC_CLIENT_ID")     || "";
const ENV_RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET") || "";
const ENV_RC_REFRESH_TOKEN = Deno.env.get("RC_REFRESH_TOKEN") || "";
const ENV_RC_FROM_NUMBER   = Deno.env.get("RC_FROM_NUMBER")   || "";

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

function toE164(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  if (digits.length > 7) return "+" + digits;
  return null;
}

type RcAuthMethod = "oauth" | "jwt";

interface RcCreds {
  authMethod:    RcAuthMethod;
  clientId:      string;
  clientSecret:  string;
  refreshToken?: string;   // required when authMethod === "oauth"
  jwtCredential?: string;  // required when authMethod === "jwt"
}

// Module-level access-token cache. Keyed by `${businessId}:${authMethod}`
// because rotating auth method on a row should invalidate any cached
// token. Per-Edge-Function-instance scope — cold-start drops it. RC
// access tokens last ~60min; we evict at 50min to leave headroom.
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
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token; // 30s safety margin
  const token = await rcAccessToken(creds);
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
  return token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  // Step 1: caller auth + tenant resolution.
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

  // Resolve tenant from users.business_id.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userRow = await admin.from("users").select("business_id").eq("id", callerAuthId).maybeSingle();
  const businessId = userRow.data?.business_id;
  if (!businessId) return json(403, { error: "No tenant for caller" });

  // Rate limit (security audit 3b): split check/increment pattern via
  // mig 066 RPCs. Two keys checked up front, both incremented only on
  // success. Failed sends (RC token expired, recipient gate rejection,
  // etc.) don't consume budget.
  //   user:<auth_uid>:send-sms     — 100/hr/user
  //   tenant:<business_id>:sms_all — 500/hr/tenant
  // Fail-open on RPC error so a transient DB issue doesn't block real
  // operations.
  const userRateKey   = `user:${callerAuthId}:send-sms`;
  const tenantRateKey = `tenant:${businessId}:sms_all`;
  const USER_LIMIT    = 100;
  const TENANT_LIMIT  = 500;
  const userCheck = await admin.rpc("rate_limit_check", {
    p_key: userRateKey, p_max: USER_LIMIT, p_window_seconds: 3600,
  });
  if (userCheck.error) {
    console.error("[send-sms] rate_limit_check (user) failed:", userCheck.error);
  } else if (userCheck.data === false) {
    return json(429, {
      error:  "rate_limit_exceeded",
      detail: `Per-user limit ${USER_LIMIT}/hr exceeded for send-sms`,
    });
  }
  const tenantCheck = await admin.rpc("rate_limit_check", {
    p_key: tenantRateKey, p_max: TENANT_LIMIT, p_window_seconds: 3600,
  });
  if (tenantCheck.error) {
    console.error("[send-sms] rate_limit_check (tenant) failed:", tenantCheck.error);
  } else if (tenantCheck.data === false) {
    return json(429, {
      error:  "rate_limit_exceeded",
      detail: `Per-tenant SMS limit ${TENANT_LIMIT}/hr exceeded`,
    });
  }

  // Step 2: parse payload.
  let body: { to_phone?: string; message?: string; allow_unknown_recipient?: boolean };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const toRaw   = (body.to_phone || "").toString();
  const message = (body.message  || "").toString();
  // Strict-equality boolean check: only the literal `true` enables the
  // bypass. Truthy strings ("true", "1") or numbers don't qualify, so a
  // confused caller can't accidentally widen the surface.
  const allowUnknown = body.allow_unknown_recipient === true;
  if (!toRaw)   return json(400, { error: "Missing to_phone" });
  if (!message) return json(400, { error: "Missing message" });
  const to = toE164(toRaw);
  if (!to) return json(400, { error: "Could not parse to_phone to E.164" });

  // 10-digit minimum is input sanitation (not a tenant-scoping check)
  // and runs unconditionally — applies even when the contact-list
  // bypass is on.
  const toLast10 = to.replace(/\D/g, "").slice(-10);
  if (toLast10.length !== 10) {
    return json(400, { error: "Phone number must contain at least 10 digits" });
  }

  // Phone validation: only allow texting numbers that exist in this
  // tenant's clients (primary OR additional_phones) or employees.
  // Without this, an authenticated user could text any phone number
  // worldwide using the tenant's RC. We match on the last 10 digits,
  // the same pattern the app uses internally for client lookups
  // (see getClientByPhone in index.html).
  //
  // additional_phones is text[]; PostgREST array operators (`cs`, `ov`)
  // don't do suffix matching on elements, so we pull the candidate rows
  // and filter in JS.
  //
  // `allow_unknown_recipient: true` in the request body skips this
  // entire block. Callers should only set the flag when they have a
  // legitimate reason to send to a number not in clients/employees:
  //   - sendQuoteViaRC (quote sent to a prospect not yet a client)
  //   - sendReply       (reply to an inbound SMS from an unknown number)
  // All other dispatch paths (sendOnMyWay, sendAllBalanceFollowups,
  // Claire's send_text, any future paths) leave the flag off and stay
  // gated by the contact-list check.
  if (!allowUnknown) {
    // Primary phone match on clients + employees.
    const [clientPrimary, employeeHit] = await Promise.all([
      admin
        .from("clients")
        .select("id")
        .eq("business_id", businessId)
        .ilike("phone", `%${toLast10}`)
        .limit(1),
      admin
        .from("employees")
        .select("id")
        .eq("business_id", businessId)
        .ilike("phone", `%${toLast10}`)
        .limit(1),
    ]);

    let allowed =
      (clientPrimary.data && clientPrimary.data.length > 0) ||
      (employeeHit.data && employeeHit.data.length > 0);

    // additional_phones (text[]) match — only check if not already allowed.
    // Scope is narrow: same business, additional_phones is non-empty.
    if (!allowed) {
      const { data: extras } = await admin
        .from("clients")
        .select("id, additional_phones")
        .eq("business_id", businessId)
        .not("additional_phones", "is", null);
      if (extras && extras.length > 0) {
        for (const row of extras) {
          const phones = (row.additional_phones as string[] | null) || [];
          for (const p of phones) {
            if ((p || "").replace(/\D/g, "").slice(-10) === toLast10) {
              allowed = true;
              break;
            }
          }
          if (allowed) break;
        }
      }
    }

    if (!allowed) {
      return json(403, {
        error: "Recipient phone number not found in this tenant's clients or employees",
        hint:  "SMS can only be sent to numbers already in your contacts. Add the recipient as a client (primary or additional phone) or employee first.",
      });
    }
  }

  // Step 3: resolve this tenant's RC integration.
  const integ = await admin.rpc("get_active_phone_integration", {
    p_business_id: businessId,
    p_provider:    "ringcentral",
  });
  const row = (integ.data && integ.data[0]) || null;
  if (!row) {
    return json(424, {
      error: "No active RingCentral integration configured for this tenant",
      hint:  "Add a row to business_phone_integrations or have an owner/admin set it up in Settings."
    });
  }

  // Step 4: resolve credentials. Env-source means "use the platform
  // env vars" (Manna Maids' transitional state, always OAuth). Otherwise
  // branch on credentials.auth_method: 'jwt' uses the JWT bearer-grant
  // path, anything else (missing, 'oauth', or unknown) uses the legacy
  // OAuth refresh-token path so existing rows keep working.
  const credsJson = (row.credentials || {}) as Record<string, unknown>;
  let creds: RcCreds;
  let fromNumber = row.phone_number_e164 || ENV_RC_FROM_NUMBER;
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
  if (!fromNumber) return json(500, { error: "Integration phone_number_e164 not set" });

  // Step 5: refresh token + send.
  try {
    const accessToken = await getCachedRcAccessToken(businessId, creds);
    const sendResp = await fetch(
      "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { phoneNumber: fromNumber },
          to:   [{ phoneNumber: to }],
          text: message,
        }),
      },
    );
    if (!sendResp.ok) {
      const detail = await sendResp.text();
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `RC SMS send ${sendResp.status}: ${detail.slice(0, 200)}`,
      });
      return json(502, { error: "RC SMS send failed", status: sendResp.status, detail });
    }
    const sent = await sendResp.json();
    await admin.rpc("mark_phone_integration_used", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
    });
    // mig 066: increment both rate-limit keys ONLY on success. Failed
    // sends above (RC non-ok, fetch throw) returned before reaching
    // here, so they don't consume budget.
    await admin.rpc("rate_limit_increment", { p_key: userRateKey,   p_window_seconds: 3600 });
    await admin.rpc("rate_limit_increment", { p_key: tenantRateKey, p_window_seconds: 3600 });
    return json(200, { ok: true, msg_id: sent.id, to, from: fromNumber });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await admin.rpc("mark_phone_integration_error", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
      p_error:       msg,
    });
    return json(500, { error: "SMS exception", detail: msg });
  }
});
