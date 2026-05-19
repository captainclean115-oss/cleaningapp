// Edge Function: geotab-call
//
// Server-side proxy for MyGeotab's JSON-RPC API. Holds tenant Geotab
// credentials (server, database, username, password) in
// business_geotab_integrations rather than the browser bundle. The
// browser invokes this EF with a (method, params) payload; the EF
// authenticates against Geotab, caches the session per business_id
// in-memory + in business_geotab_sessions (mig 069), makes the call,
// and returns Geotab's raw result.
//
// Two-tier session cache (mig 069 fix):
//   Tier 1 — module-level Map<business_id, session>. Per-isolate, free
//     on a hot path.
//   Tier 2 — business_geotab_sessions DB table. SHARED across all
//     isolates. The original PR1/PR2 design only had tier 1, which
//     caused a 401 cascade Tom kept hitting: each cold isolate
//     re-Authenticated against Geotab, and gpsInit's 8+ concurrent
//     _geotabCall fan-out across N isolates blew Geotab's "10
//     Authenticate calls per minute per user" limit within a second.
//     With tier 2, exactly one Authenticate fires per ~50min across
//     the whole fleet; all other isolates pull from DB on cold start.
//
// Single-flight `authInFlight` Map remains (within-isolate dedup, so a
// burst of fan-out from one isolate's perspective also doesn't race
// itself). Combined with tier 2, the only Authenticate call we can fire
// is "first request after the previous session expired AND no other
// isolate has refilled the DB yet."
//
// Server pivot: Geotab returns `{result: {path: 'myXX.geotab.com',
//   credentials: {...}}}` on auth. `path != 'ThisServer'` means
//   subsequent calls must go to that returned host. We persist the
//   post-pivot server in the DB so every isolate hits the right host.
//
// Method allowlist: `Get`, `GetCountOf`, `GetAddresses`. Write methods
//   (`Add`, `Set`, `Remove`) remain blocked.
//
// Rate limit: 600/hr/user via mig 066's split pattern. Increment fires
//   only on success — Geotab 4xx / auth failures don't consume budget.

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

// Sessions are valid hours on Geotab's side, but we cap at 50min so we
// re-auth proactively before any documented edge case. The DB row's
// expires_at column drives this.
const SESSION_TTL_MS = 50 * 60 * 1000;

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

// Tier 1: module-level cache. Per-isolate, sub-millisecond hit path.
const sessionCache = new Map<string, { session: GeotabSession; expiresAt: number }>();

// Within-isolate single-flight: if a burst of fan-out arrives on the
// same isolate with no cached session, only one auth path runs; the
// rest await its promise. Cross-isolate dedup is handled by the DB
// (tier 2) — the second isolate's auth path checks the DB first and
// sees the first isolate's fresh row.
const authInFlight = new Map<string, Promise<GeotabSession>>();

// deno-lint-ignore no-explicit-any
type Admin = ReturnType<typeof createClient<any, any, any>>;

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

async function getCachedSession(
  admin: Admin,
  businessId: string,
  creds: GeotabCreds,
): Promise<GeotabSession> {
  // Tier 1: module-level cache hit (this isolate already has a valid session)
  const memHit = sessionCache.get(businessId);
  if (memHit && memHit.expiresAt > Date.now() + 30_000) return memHit.session;

  // Within-isolate single-flight
  const inFlight = authInFlight.get(businessId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      // Tier 2: shared DB session. Any other isolate that auth'd in the
      // last ~50min populated this. Hits per-business at most every
      // 50min across the entire fleet.
      const dbRes = await admin.rpc("get_geotab_session", { p_business_id: businessId });
      const dbRow = (dbRes.data && dbRes.data[0]) || null;
      if (dbRow && !dbRes.error) {
        const session: GeotabSession = {
          server:    String(dbRow.server),
          sessionId: String(dbRow.session_id),
          userName:  String(dbRow.user_name),
          database:  String(dbRow.database),
        };
        const expiresAt = new Date(dbRow.expires_at).getTime();
        sessionCache.set(businessId, { session, expiresAt });
        return session;
      }

      // Tier 3: no cached session anywhere — authenticate against Geotab.
      // This is the only path that can hit Geotab's 10-Authenticate/min
      // limit, and with tier 2 in place it fires at most once per ~50min
      // per business (plus the rare cross-isolate cold-start race, which
      // bounds to N simultaneous isolates spinning up — typically 1-2).
      const session = await geotabAuthenticate(creds);
      const expiresAt = Date.now() + SESSION_TTL_MS;
      sessionCache.set(businessId, { session, expiresAt });
      // Persist to DB so the next isolate / next request doesn't re-auth.
      // Best-effort: a write failure shouldn't poison the call we're
      // already mid-handling — just log and continue with the in-memory
      // session.
      const setRes = await admin.rpc("set_geotab_session", {
        p_business_id: businessId,
        p_session_id:  session.sessionId,
        p_user_name:   session.userName,
        p_database:    session.database,
        p_server:      session.server,
        p_expires_at:  new Date(expiresAt).toISOString(),
      });
      if (setRes.error) {
        console.error("[geotab-call] set_geotab_session failed:", setRes.error);
      }
      return session;
    } finally {
      authInFlight.delete(businessId);
    }
  })();
  authInFlight.set(businessId, promise);
  return promise;
}

async function bustSession(admin: Admin, businessId: string): Promise<void> {
  sessionCache.delete(businessId);
  const res = await admin.rpc("delete_geotab_session", { p_business_id: businessId });
  if (res.error) console.error("[geotab-call] delete_geotab_session failed:", res.error);
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
      detail: `Only ${[...ALLOWED_METHODS].join(", ")} are allowed. Write methods deferred.`,
    });
  }

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

  let session: GeotabSession;
  try {
    session = await getCachedSession(admin, businessId, creds);
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

  let result: unknown;
  try {
    result = await geotabApiCall(session, method, params);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (msg === "__SESSION_EXPIRED__") {
      console.warn("[geotab-call] session expired, busting + re-authing + retrying");
      await bustSession(admin, businessId);
      try {
        const fresh = await getCachedSession(admin, businessId, creds);
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
  await admin.rpc("rate_limit_increment", { p_key: userRateKey, p_window_seconds: 3600 });
  return json(200, { result });
});
