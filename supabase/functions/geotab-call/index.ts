// Edge Function: geotab-call
//
// Server-side proxy for MyGeotab's JSON-RPC API. Holds tenant Geotab
// credentials (server, database, username, password) in
// business_geotab_integrations rather than the browser bundle. The
// browser invokes this EF with a (method, params) payload; the EF
// authenticates against Geotab, caches the session per business_id
// in-memory ~50min, makes the call, and returns Geotab's raw result.
//
// PR1 of Geotab strategy split (mirrors SMS PR #24 shape):
//   server-side capability only. The 8+ `geotabCall(...)` sites in
//   index.html still go browser-direct against the hardcoded
//   GEOTAB_* constants. Manna's production fleet tracking is
//   unaffected by this PR — Test button is the only caller of this
//   EF today. PR2 rewires all those sites + deletes the constants.
//
// Server pivot: Geotab returns `{result: {path: 'myXX.geotab.com',
//   credentials: {...}}}` on auth. `path != 'ThisServer'` means
//   subsequent calls must go to that returned host. The session cache
//   stores the post-pivot server alongside the sessionId so every
//   subsequent geotab-call invocation hits the right host.
//
// Method allowlist: `Get`, `GetCountOf`, `GetAddresses` (PR2 extended
//   the allowlist to include GetAddresses for the live-map reverse-
//   geocode path). Write methods (`Add`, `Set`, `Remove`) remain
//   blocked — no current surface needs them server-side, and the
//   allowlist gives a defense-in-depth bound on what a compromised
//   authenticated user could do with the tenant's Geotab credentials.
//
// Rate limit (PR2): 600/hr/user via mig 066's split pattern. The hours
//   rollup + live map + locate_team Claire tool each fan out 2-3
//   geotab calls per render, so a manager actively using multiple
//   surfaces could fire ~30/hr; 600/hr leaves 20x headroom and
//   catches runaway loops within seconds. Increment fires only on
//   success — Geotab 4xx / auth failures don't consume budget.

import { serve }       from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY") || "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY env var");
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ALLOWED_METHODS = new Set(["Get", "GetCountOf", "GetAddresses"]);

interface GeotabSession {
  server:    string;
  sessionId: string;
  userName:  string;
  database:  string;
}

interface GeotabCreds {
  server:   string;
  database: string;
  username: string;
  password: string;
}

// Module-level session cache keyed by business_id. Geotab sessions
// don't have a documented absolute expiry but are valid hours; we evict
// after 50min and re-auth on session-expired errors regardless.
const sessionCache = new Map<string, { session: GeotabSession; expiresAt: number }>();

async function geotabAuthenticate(creds: GeotabCreds): Promise<GeotabSession> {
  const resp = await fetch(`https://${creds.server}/apiv1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      method: "Authenticate",
      params: {
        userName: creds.username,
        password: creds.password,
        database: creds.database,
      },
      id: -1,
    }),
  });
  if (!resp.ok) throw new Error(`Geotab auth HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  if (data.error) {
    const msg = data.error.errors ? data.error.errors[0].message
                                   : (data.error.message || JSON.stringify(data.error));
    throw new Error(`Geotab auth error: ${msg}`);
  }
  if (!data.result) throw new Error("Geotab auth returned no result");
  const result = data.result;
  // Server pivot — Geotab returns the actual server to use in result.path.
  // 'ThisServer' (literal) means "stay on the host you authenticated to".
  let effectiveServer = creds.server;
  if (result.path && result.path !== "ThisServer") {
    effectiveServer = result.path;
  }
  const sessionCreds = result.credentials || {};
  if (!sessionCreds.sessionId) throw new Error("Geotab auth missing sessionId");
  return {
    server:    effectiveServer,
    sessionId: String(sessionCreds.sessionId),
    userName:  String(sessionCreds.userName || creds.username),
    database:  String(sessionCreds.database || creds.database),
  };
}

async function getCachedSession(businessId: string, creds: GeotabCreds): Promise<GeotabSession> {
  const hit = sessionCache.get(businessId);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.session;
  const session = await geotabAuthenticate(creds);
  sessionCache.set(businessId, { session, expiresAt: Date.now() + 50 * 60 * 1000 });
  return session;
}

async function geotabApiCall(
  session: GeotabSession,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(`https://${session.server}/apiv1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      method,
      params: {
        ...params,
        credentials: {
          userName:  session.userName,
          sessionId: session.sessionId,
          database:  session.database,
        },
      },
      id: -1,
    }),
  });
  if (!resp.ok) throw new Error(`Geotab HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  if (data.error) {
    const msg = data.error.errors ? data.error.errors[0].message
                                   : (data.error.message || JSON.stringify(data.error));
    // Surface session-expiry to caller via a sentinel — we'll bust
    // cache + retry once.
    if (msg.toLowerCase().includes("session")
     || msg.toLowerCase().includes("authenticate")
     || msg.includes("InvalidUserException")) {
      throw new Error("__SESSION_EXPIRED__");
    }
    throw new Error(`Geotab error: ${msg}`);
  }
  return data.result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  // Auth gate (verify_jwt:true already 401s at gateway; explicit error here).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Empty bearer token" });
  const caller = createClient(SUPABASE_URL, ANON_KEY);
  const { data: callerData, error: callerErr } = await caller.auth.getUser(jwt);
  if (callerErr) {
    console.error("[geotab-call] auth getUser failed:", callerErr.message);
    return json(401, { error: "Invalid JWT", detail: callerErr.message });
  }
  if (!callerData.user) return json(401, { error: "Invalid JWT (no user)" });
  const callerAuthId = callerData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userRow = await admin.from("users").select("business_id").eq("id", callerAuthId).maybeSingle();
  const businessId = userRow.data?.business_id as string | undefined;
  if (!businessId) return json(403, { error: "No tenant for caller" });

  // Rate limit (security audit 3b pattern): 600/hr/user, split
  // check/increment. Increment fires only on success below.
  const userRateKey = `user:${callerAuthId}:geotab-call`;
  const USER_LIMIT  = 600;
  const checkRes = await admin.rpc("rate_limit_check", {
    p_key: userRateKey, p_max: USER_LIMIT, p_window_seconds: 3600,
  });
  if (checkRes.error) {
    console.error("[geotab-call] rate_limit_check failed:", checkRes.error);
  } else if (checkRes.data === false) {
    return json(429, {
      error:  "rate_limit_exceeded",
      detail: `Per-user limit ${USER_LIMIT}/hr exceeded for geotab-call`,
    });
  }

  // Parse + validate body
  let body: { method?: unknown; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const method = typeof body.method === "string" ? body.method : "";
  const params = (body.params && typeof body.params === "object") ? body.params as Record<string, unknown> : {};
  if (!method) return json(400, { error: "Missing method" });
  if (!ALLOWED_METHODS.has(method)) {
    return json(400, {
      error:  "Method not allowed",
      detail: `Only ${[...ALLOWED_METHODS].join(", ")} are allowed in PR1. Write methods deferred.`,
    });
  }

  // Resolve tenant's Geotab integration credentials.
  const integ = await admin.rpc("get_active_geotab_integration", { p_business_id: businessId });
  const row = (integ.data && integ.data[0]) || null;
  if (!row) {
    return json(424, {
      error: "No active Geotab integration configured for this tenant",
      hint:  "Have an owner/admin set it up in Admin → Fleet Tracking (Geotab).",
    });
  }
  const creds: GeotabCreds = {
    server:   String(row.server   || "my.geotab.com"),
    database: String(row.database || ""),
    username: String(row.username || ""),
    password: String(row.password || ""),
  };
  if (!creds.database || !creds.username || !creds.password) {
    return json(500, { error: "Integration credentials incomplete (missing database/username/password)" });
  }

  // Get session (cached or fresh auth). On auth failure → 401 with hint.
  let session: GeotabSession;
  try {
    session = await getCachedSession(businessId, creds);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error("[geotab-call] auth failed:", msg);
    await admin.rpc("mark_geotab_integration_error", { p_business_id: businessId, p_error: msg });
    return json(401, {
      error:  "Geotab authentication failed",
      hint:   "Have an owner/admin re-paste a fresh password in Admin → Fleet Tracking (Geotab).",
      detail: msg,
    });
  }

  // Make the API call. On session expired, bust cache + retry once.
  let result: unknown;
  try {
    result = await geotabApiCall(session, method, params);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (msg === "__SESSION_EXPIRED__") {
      console.warn("[geotab-call] session expired, re-authing + retrying");
      sessionCache.delete(businessId);
      try {
        const fresh = await getCachedSession(businessId, creds);
        result = await geotabApiCall(fresh, method, params);
      } catch (retryE) {
        const retryMsg = (retryE as Error).message || String(retryE);
        await admin.rpc("mark_geotab_integration_error", { p_business_id: businessId, p_error: retryMsg });
        return json(502, { error: "Geotab call failed after re-auth", detail: retryMsg });
      }
    } else {
      await admin.rpc("mark_geotab_integration_error", { p_business_id: businessId, p_error: msg });
      return json(502, { error: "Geotab call failed", detail: msg });
    }
  }

  await admin.rpc("mark_geotab_integration_used", { p_business_id: businessId });
  // mig 066: increment rate-limit only on success. Geotab 4xx / auth
  // failures returned above before reaching here, so they don't
  // consume budget.
  await admin.rpc("rate_limit_increment", { p_key: userRateKey, p_window_seconds: 3600 });
  return json(200, { result });
});
