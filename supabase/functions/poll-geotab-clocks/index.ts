// Edge Function: poll-geotab-clocks
//
// GPS-as-truth clock-in/out, PR #2 of 3. Cron-triggered (pg_cron ->
// trigger_poll_geotab_clocks() -> net.http_post, migration 076), no user
// JWT -- verify_jwt stays true (project convention), but the only
// caller that can pass the gateway's signature check AND this
// function's own role check is whoever holds the service_role key
// (checked via the decoded `role` claim; the platform already verified
// the JWT signature before this code runs).
//
// Session/auth against Geotab intentionally duplicates geotab-call's
// helpers rather than importing from it -- geotab-call is a live,
// carefully-tuned EF (two-tier session cache, rate limiting; see its own
// header comment) and refactoring it into a shared module for this PR
// risks destabilizing it for no functional gain. The DB-tier session
// cache (business_geotab_sessions, via get_geotab_session/
// set_geotab_session) IS still shared correctly across both EFs, since
// both call the same RPCs -- so this doesn't cause duplicate
// Authenticate calls against Geotab, just duplicate TS.
//
// Per-poll algorithm, per tenant, per team:
//   1. Get Device -> match device.name to team code (same
//      substring-contains convention as index.html's matchStopToClient
//      callers -- not a DB mapping, see PR #1's recon).
//   2. Get Trip for that device, last 30 minutes.
//   3. Office bookends: earliest startPoint-at-office = office_start
//      (payroll clock-in for the day), latest stopPoint-at-office =
//      office_end (payroll clock-out). "At office" = within that
//      office's own radius_km, not the 61m client geofence.
//   4. Every other stopPoint = a candidate job_start (client arrival);
//      every other startPoint = a candidate job_end (client departure).
//      Both resolved via resolve_job_from_gps_stop (61m, PR #1).
//   5. Every resolution logs to gps_match_log regardless of outcome.
//      Writes to jobs.actual_start_at/actual_end_at and time_entries
//      only happen if the tenant's gps_clock_writes_enabled is true
//      (off by default -- see migration 076) and the target column is
//      still NULL (never overwrites a manual clock).
//
// Date-for-matching: jobs.date has no timezone, entered/scheduled in
// business-local terms. Converted from each trip's UTC timestamp using
// a hardcoded America/New_York assumption -- same fallback this project
// already standardized on for business timezone (PRs #43-#47) rather
// than building new per-tenant TZ plumbing for a single-tenant polling
// job.

import { serve }        from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient }  from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Geotab session/auth (duplicated from geotab-call, see header) ───

const SESSION_TTL_MS = 50 * 60 * 1000;

interface GeotabSession { server: string; sessionId: string; userName: string; database: string; }
interface GeotabCreds   { server: string; database: string; username: string; password: string; }

const sessionCache  = new Map<string, { session: GeotabSession; expiresAt: number }>();
const authInFlight  = new Map<string, Promise<GeotabSession>>();

// deno-lint-ignore no-explicit-any
type Admin = ReturnType<typeof createClient<any, any, any>>;

async function geotabAuthenticate(creds: GeotabCreds): Promise<GeotabSession> {
  const resp = await fetch(`https://${creds.server}/apiv1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      method: "Authenticate",
      params: { userName: creds.username, password: creds.password, database: creds.database },
      id: -1,
    }),
  });
  if (!resp.ok) throw new Error(`Geotab auth HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  if (data.error) {
    const msg = data.error.errors ? data.error.errors[0].message : (data.error.message || JSON.stringify(data.error));
    throw new Error(`Geotab auth error: ${msg}`);
  }
  if (!data.result) throw new Error("Geotab auth returned no result");
  const result = data.result;
  let effectiveServer = creds.server;
  if (result.path && result.path !== "ThisServer") effectiveServer = result.path;
  const sessionCreds = result.credentials || {};
  if (!sessionCreds.sessionId) throw new Error("Geotab auth missing sessionId");
  return {
    server: effectiveServer,
    sessionId: String(sessionCreds.sessionId),
    userName: String(sessionCreds.userName || creds.username),
    database: String(sessionCreds.database || creds.database),
  };
}

async function getCachedSession(admin: Admin, businessId: string, creds: GeotabCreds): Promise<GeotabSession> {
  const memHit = sessionCache.get(businessId);
  if (memHit && memHit.expiresAt > Date.now() + 30_000) return memHit.session;

  const inFlight = authInFlight.get(businessId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const dbRes = await admin.rpc("get_geotab_session", { p_business_id: businessId });
      const dbRow = (dbRes.data && dbRes.data[0]) || null;
      if (dbRow && !dbRes.error) {
        const session: GeotabSession = {
          server: String(dbRow.server), sessionId: String(dbRow.session_id),
          userName: String(dbRow.user_name), database: String(dbRow.database),
        };
        const expiresAt = new Date(dbRow.expires_at).getTime();
        sessionCache.set(businessId, { session, expiresAt });
        return session;
      }
      const session = await geotabAuthenticate(creds);
      const expiresAt = Date.now() + SESSION_TTL_MS;
      sessionCache.set(businessId, { session, expiresAt });
      const setRes = await admin.rpc("set_geotab_session", {
        p_business_id: businessId, p_session_id: session.sessionId, p_user_name: session.userName,
        p_database: session.database, p_server: session.server, p_expires_at: new Date(expiresAt).toISOString(),
      });
      if (setRes.error) console.error("[poll-geotab-clocks] set_geotab_session failed:", setRes.error);
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
  if (res.error) console.error("[poll-geotab-clocks] delete_geotab_session failed:", res.error);
}

async function geotabApiCall(session: GeotabSession, method: string, params: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`https://${session.server}/apiv1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      method, params: { ...params, credentials: { userName: session.userName, sessionId: session.sessionId, database: session.database } }, id: -1,
    }),
  });
  if (!resp.ok) throw new Error(`Geotab HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  if (data.error) {
    const msg = data.error.errors ? data.error.errors[0].message : (data.error.message || JSON.stringify(data.error));
    if (msg.toLowerCase().includes("session") || msg.toLowerCase().includes("authenticate") || msg.includes("InvalidUserException")) {
      throw new Error("__SESSION_EXPIRED__");
    }
    throw new Error(`Geotab error: ${msg}`);
  }
  return data.result;
}

async function callWithReauth(admin: Admin, businessId: string, creds: GeotabCreds, method: string, params: Record<string, unknown>): Promise<any> {
  const session = await getCachedSession(admin, businessId, creds);
  try {
    return await geotabApiCall(session, method, params);
  } catch (e) {
    if ((e as Error).message === "__SESSION_EXPIRED__") {
      await bustSession(admin, businessId);
      const fresh = await getCachedSession(admin, businessId, creds);
      return await geotabApiCall(fresh, method, params);
    }
    throw e;
  }
}

// ─── Geometry / date helpers ──────────────────────────────────────────

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const ET_DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
function etDateString(iso: string): string {
  return ET_DATE_FMT.format(new Date(iso)); // en-CA => YYYY-MM-DD
}

interface Office { id: string; name: string; lat: number; lng: number; radius_km: string; teams: string[]; }
function officeForPoint(offices: Office[], lat: number, lng: number): Office | null {
  for (const o of offices) {
    if (haversineMeters(lat, lng, o.lat, o.lng) <= Number(o.radius_km) * 1000) return o;
  }
  return null;
}

// ─── Per-tenant poll ───────────────────────────────────────────────

// A job's GPS-derived time counts as "divergent" against an existing
// manual time past this threshold -- matches PR #3's stated 15-minute
// job alert threshold. Not an alert itself (PR #3 owns the trigger +
// audit_log write); just feeds the run-summary counts Tom asked for.
const JOB_DIVERGENCE_THRESHOLD_MIN = 15;

interface Counters {
  trips: number; matches: number; misses: number;
  jobsNewlyClocked: number; jobsSkippedExisting: number; jobsDivergent: number;
  deviceAssignmentResolved: number; deviceNameMatched: number;
}

// Device-to-team override (migration 080): explicit team_device_
// assignments row wins; falls back to the existing name-matching only
// when no assignment row exists for that team+date at all. Mirrors the
// browser's _resolveTeamDevice (index.html) -- same RPC, same fallback
// semantics, kept as a separate small copy here rather than a shared
// module for the same reason geotab-call's session logic is duplicated
// (see this file's header comment).
async function resolveTeamDevice(admin: Admin, businessId: string, team: string, onDate: string, devices: any[], counters: Counters): Promise<any> {
  // get_team_device_for_poll, not get_team_device: this EF runs as
  // service_role, which has no table grant on team_device_assignments
  // (deliberate project convention) — get_team_device is SECURITY
  // INVOKER for the browser's RLS-backed path and would 42501 here.
  // See migration 081's comment for the full story.
  const res = await admin.rpc("get_team_device_for_poll", { p_business_id: businessId, p_team_code: team, p_on_date: onDate });
  if (!res.error && Array.isArray(res.data) && res.data.length > 0) {
    counters.deviceAssignmentResolved++;
    const assignedId = res.data[0].device_id;
    if (!assignedId) return null; // explicit no-GPS for this team today
    return (devices || []).find((d: any) => String(d.id) === String(assignedId)) || null;
  }
  counters.deviceNameMatched++;
  return (devices || []).find((d: any) => d.name && String(d.name).toUpperCase().includes(team)) || null;
}

async function pollTenant(admin: Admin, integ: any, counters: Counters) {
  const businessId = integ.business_id as string;
  const creds: GeotabCreds = { server: integ.server || "my.geotab.com", database: integ.database, username: integ.username, password: integ.password };

  const officesRes = await admin.rpc("get_business_offices_for_polling", { p_business_id: businessId });
  const offices: Office[] = officesRes.data || [];
  if (!offices.length) return; // nothing to geofence teams against

  const devices = await callWithReauth(admin, businessId, creds, "Get", { typeName: "Device", resultsLimit: 50 });

  // Bookkeeping only (migration 082) -- no effect on matching logic.
  // Lets Live Tracking show every device the tenant has ever seen, not
  // just ones currently matched to a team, and tracks last_seen_at for
  // "missing" (assigned but not reporting) detection.
  for (const d of devices || []) {
    if (d && d.id != null) {
      await admin.rpc("upsert_geotab_device_seen", { p_business_id: businessId, p_geotab_device_id: String(d.id) });
    }
  }

  const allTeams = Array.from(new Set(offices.flatMap((o) => o.teams || [])));

  const now = new Date();
  const windowStart = new Date(now.getTime() - 30 * 60 * 1000);
  const todayStr = etDateString(now.toISOString());

  for (const team of allTeams) {
    const device = await resolveTeamDevice(admin, businessId, team, todayStr, devices, counters);
    if (!device) continue;

    let trips: any[];
    try {
      trips = await callWithReauth(admin, businessId, creds, "Get", {
        typeName: "Trip",
        search: { deviceSearch: { id: device.id }, fromDate: windowStart.toISOString(), toDate: now.toISOString(), includeOverlappedTrips: true },
        resultsLimit: 100,
      });
    } catch (e) {
      console.error(`[poll-geotab-clocks] Trip fetch failed for ${businessId}/${team}:`, (e as Error).message);
      continue;
    }
    trips = (trips || []).slice().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    counters.trips += trips.length;
    if (!trips.length) continue;

    // Office bookends for the day: earliest office-radius startPoint,
    // latest office-radius stopPoint.
    let officeStart: { at: string; lat: number; lng: number } | null = null;
    let officeEnd:   { at: string; lat: number; lng: number } | null = null;

    for (const t of trips) {
      if (t.startPoint && officeForPoint(offices, t.startPoint.y, t.startPoint.x)) {
        if (!officeStart || new Date(t.start) < new Date(officeStart.at)) {
          officeStart = { at: t.start, lat: t.startPoint.y, lng: t.startPoint.x };
        }
      }
      if (t.stopPoint && officeForPoint(offices, t.stopPoint.y, t.stopPoint.x)) {
        if (!officeEnd || new Date(t.stop) > new Date(officeEnd.at)) {
          officeEnd = { at: t.stop, lat: t.stopPoint.y, lng: t.stopPoint.x };
        }
      }
    }

    if (officeStart) {
      await admin.rpc("write_office_gps_clock", {
        p_business_id: businessId, p_team_code: team, p_date: etDateString(officeStart.at),
        p_mode: "start", p_gps_at: officeStart.at, p_lat: officeStart.lat, p_lng: officeStart.lng,
      });
    }
    if (officeEnd) {
      await admin.rpc("write_office_gps_clock", {
        p_business_id: businessId, p_team_code: team, p_date: etDateString(officeEnd.at),
        p_mode: "end", p_gps_at: officeEnd.at, p_lat: officeEnd.lat, p_lng: officeEnd.lng,
      });
    }

    // Client arrivals (stopPoint, not at an office) and departures
    // (startPoint, not at an office). p_geotab_trip_id/p_point_type
    // make each resolution idempotent -- replaying the same trip+point
    // in an overlapping poll window returns the original outcome
    // instead of re-matching or double-logging (migration 079).
    const deviceId = device.id != null ? String(device.id) : null;
    for (const t of trips) {
      const tripId = t.id != null ? String(t.id) : null;
      if (t.stopPoint && !officeForPoint(offices, t.stopPoint.y, t.stopPoint.x)) {
        const resolved = await admin.rpc("resolve_job_from_gps_stop", {
          p_business_id: businessId, p_lat: t.stopPoint.y, p_lng: t.stopPoint.x,
          p_date: etDateString(t.stop), p_team_code: team, p_event_at: t.stop,
          p_device_id: deviceId, p_geotab_trip_id: tripId, p_point_type: "stop", p_radius_meters: 61,
        });
        const row = (resolved.data && resolved.data[0]) || null;
        if (row && row.job_id) {
          counters.matches++;
          const wr = await admin.rpc("write_job_gps_clock", { p_business_id: businessId, p_job_id: row.job_id, p_mode: "start", p_gps_at: t.stop, p_match_log_id: row.log_id });
          tallyWriteResult(wr.data && wr.data[0], counters);
        } else {
          counters.misses++;
        }
      }
      if (t.startPoint && !officeForPoint(offices, t.startPoint.y, t.startPoint.x)) {
        const resolved = await admin.rpc("resolve_job_from_gps_stop", {
          p_business_id: businessId, p_lat: t.startPoint.y, p_lng: t.startPoint.x,
          p_date: etDateString(t.start), p_team_code: team, p_event_at: t.start,
          p_device_id: deviceId, p_geotab_trip_id: tripId, p_point_type: "start", p_radius_meters: 61,
        });
        const row = (resolved.data && resolved.data[0]) || null;
        if (row && row.job_id) {
          counters.matches++;
          const wr = await admin.rpc("write_job_gps_clock", { p_business_id: businessId, p_job_id: row.job_id, p_mode: "end", p_gps_at: t.start, p_match_log_id: row.log_id });
          tallyWriteResult(wr.data && wr.data[0], counters);
        } else {
          counters.misses++;
        }
      }
    }
  }
}

function tallyWriteResult(result: { did_write?: boolean; skipped_existing?: boolean; divergent_minutes?: number } | null | undefined, counters: Counters) {
  if (!result) return;
  if (result.did_write) counters.jobsNewlyClocked++;
  if (result.skipped_existing) {
    counters.jobsSkippedExisting++;
    if (typeof result.divergent_minutes === "number" && result.divergent_minutes >= JOB_DIVERGENCE_THRESHOLD_MIN) {
      counters.jobsDivergent++;
    }
  }
}

const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY env var");

const MANAGER_ROLES = new Set(["owner", "admin", "manager", "dispatcher"]);

serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Missing Authorization header" });
  let decodedRole = "";
  try {
    decodedRole = (JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role) || "";
  } catch {
    return json(401, { error: "Malformed JWT" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // Two callers: pg_cron (service_role, all tenants) or a manager
  // clicking "Run poll now" in Admin -> Fleet Tracking (their own user
  // JWT, scoped to their own tenant only). Anything else is rejected.
  // The platform's own JWT-signature verification (verify_jwt=true) has
  // already run by the time this code executes -- for the service_role
  // path, checking the decoded role claim is sufficient. For the manual
  // path we go further and re-verify the JWT against Supabase Auth
  // (caller.auth.getUser), since this path grants an authenticated user
  // the ability to trigger polling, not just read data.
  let trigger: "cron" | "manual" = "cron";
  let scopedBusinessId: string | null = null;

  if (decodedRole === "service_role") {
    trigger = "cron";
  } else {
    const caller = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerData, error: callerErr } = await caller.auth.getUser(jwt);
    if (callerErr || !callerData.user) return json(401, { error: "Invalid JWT" });
    const userRow = await admin.from("users").select("business_id, role").eq("id", callerData.user.id).maybeSingle();
    const userBusinessId = userRow.data?.business_id as string | undefined;
    const userRole = userRow.data?.role as string | undefined;
    if (!userBusinessId || !userRole || !MANAGER_ROLES.has(userRole)) {
      return json(403, { error: "manager-tier required for manual poll trigger" });
    }
    trigger = "manual";
    scopedBusinessId = userBusinessId;
  }

  const startAt = new Date();
  const counters: Counters = { trips: 0, matches: 0, misses: 0, jobsNewlyClocked: 0, jobsSkippedExisting: 0, jobsDivergent: 0, deviceAssignmentResolved: 0, deviceNameMatched: 0 };
  let tenantsProcessed = 0;
  const errors: string[] = [];

  const integRes = await admin.rpc("list_active_geotab_integrations");
  let integrations = integRes.data || [];
  if (integRes.error) errors.push(`list_active_geotab_integrations: ${integRes.error.message}`);
  if (scopedBusinessId) integrations = integrations.filter((i: any) => i.business_id === scopedBusinessId);

  for (const integ of integrations) {
    const businessId = integ.business_id as string;

    // 1 poll per 5 min per tenant, regardless of cron or manual --
    // guards against a manual trigger landing seconds after a cron tick
    // (or a duplicated cron fire) reprocessing the same trips twice.
    const rateRes = await admin.rpc("check_rate_limit", { p_key: `poll-geotab-clocks:${businessId}`, p_max_calls: 1, p_window_seconds: 300 });
    if (rateRes.error) {
      console.error(`[poll-geotab-clocks] rate_limit check failed for ${businessId}:`, rateRes.error.message);
    } else if (rateRes.data === false) {
      errors.push(`${businessId}: rate-limited, skipped this cycle`);
      continue;
    }

    try {
      await pollTenant(admin, integ, counters);
      tenantsProcessed++;
      await admin.rpc("mark_geotab_integration_used", { p_business_id: businessId });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      console.error(`[poll-geotab-clocks] tenant ${businessId} failed:`, msg);
      errors.push(`${businessId}: ${msg}`);
      await admin.rpc("record_geotab_poll_failure", { p_business_id: businessId, p_error: msg });
    }
  }

  const endAt = new Date();
  await admin.rpc("record_poll_geotab_run", {
    p_start_at: startAt.toISOString(), p_end_at: endAt.toISOString(),
    p_tenants_processed: tenantsProcessed, p_trips_processed: counters.trips,
    p_matches: counters.matches, p_misses: counters.misses,
    p_errors: errors.length ? errors.join("; ") : null,
    p_trigger: trigger,
    p_jobs_newly_clocked: counters.jobsNewlyClocked,
    p_jobs_skipped_existing: counters.jobsSkippedExisting,
    p_jobs_divergent: counters.jobsDivergent,
    p_device_assignment_resolved: counters.deviceAssignmentResolved,
    p_device_name_matched: counters.deviceNameMatched,
  });

  return json(200, {
    ok: true, trigger, tenantsProcessed, tripsProcessed: counters.trips,
    matches: counters.matches, misses: counters.misses,
    jobsNewlyClocked: counters.jobsNewlyClocked,
    jobsSkippedExisting: counters.jobsSkippedExisting,
    jobsDivergent: counters.jobsDivergent,
    deviceAssignmentResolved: counters.deviceAssignmentResolved,
    deviceNameMatched: counters.deviceNameMatched,
    errors: errors.length ? errors : undefined,
  });
});
