-- GPS-as-truth clock-in/out, PR #2 of 3: SQL side of the polling loop.
-- Pairs with the poll-geotab-clocks Edge Function (service_role, no user
-- JWT) and a pg_cron job that fires it every 15 minutes.
--
-- ─── New extension: pg_net ──────────────────────────────────────────
-- Needed so pg_cron can invoke the Edge Function over HTTP -- neither
-- pg_net nor the older `http` extension was actually installed despite
-- what the extensions listing implied (verified against pg_extension
-- directly). This is a different case from the earthdistance/ll_to_earth
-- avoidance in PR #1: there's no plain-SQL way to make an HTTP call from
-- pg_cron, and pg_net is Supabase's own supported extension for exactly
-- this "cron triggers an Edge Function" pattern -- not avoidable here.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ─── gps_match_log: record what the GPS event actually was ─────────
-- PR #1's log captures the match (client/job/distance/confidence) but
-- not what kind of clock event was being resolved, or the GPS-derived
-- timestamp itself. Needed for two reasons:
--   1. "only write jobs.actual_start_at if NULL, never overwrite manual"
--      means a job that already has a manual time never gets its GPS
--      time written anywhere -- without this, PR #3's divergence check
--      would have nothing to diff the manual time against.
--   2. Dry-run visibility: gps_clock_writes_enabled (below) can be off
--      for a tenant while polling still runs, so this is the only
--      record of what WOULD have been written.
ALTER TABLE public.gps_match_log
  ADD COLUMN gps_event_type text CHECK (gps_event_type IN ('job_start','job_end','office_start','office_end')),
  ADD COLUMN gps_event_at   timestamptz;

-- ─── resolve_job_from_gps_stop: also return the log row id ─────────
-- The resolver doesn't know whether a stop is an arrival or departure
-- (that's trip-sequencing logic the polling EF does), so it can't set
-- gps_event_type/gps_event_at itself. Returning log_id lets the EF
-- stamp the row it just wrote via write_job_gps_clock below, without a
-- second lookup. Return-shape change requires DROP + recreate (CREATE
-- OR REPLACE can't change RETURNS TABLE columns); no caller exists
-- outside this migration's own tests, so this is safe.
DROP FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, double precision);

CREATE OR REPLACE FUNCTION public.resolve_job_from_gps_stop(
  p_business_id   uuid,
  p_lat           double precision,
  p_lng           double precision,
  p_date          date,
  p_team_code     text,
  p_radius_meters double precision DEFAULT 61
) RETURNS TABLE(
  client_id       uuid,
  job_id          uuid,
  distance_meters double precision,
  confidence      text,
  log_id          uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cand   RECORD;
  v_log_id uuid;
BEGIN
  SELECT
    c.id                                                          AS client_id,
    j.id                                                          AS job_id,
    public.haversine_meters(p_lat, p_lng, c.lat, c.lng)           AS distance_meters,
    (j.id IS NOT NULL)                                            AS has_job,
    CASE
      WHEN j.id IS NOT NULL AND public.haversine_meters(p_lat, p_lng, c.lat, c.lng) < 30  THEN 'high'
      WHEN j.id IS NOT NULL                                                               THEN 'medium'
      WHEN j.id IS NULL     AND public.haversine_meters(p_lat, p_lng, c.lat, c.lng) < 30  THEN 'low'
      ELSE 'none'
    END                                                            AS confidence
  INTO v_cand
  FROM public.clients c
  LEFT JOIN public.jobs j
    ON j.business_id = p_business_id
   AND j.client_id   = c.external_id
   AND j.date        = p_date
   AND upper(j.team)  = upper(p_team_code)
   AND j.status      <> 'cancelled'
  WHERE c.business_id = p_business_id
    AND c.status      = 'active'
    AND c.deleted_at IS NULL
    AND c.lat IS NOT NULL AND c.lng IS NOT NULL
    AND public.haversine_meters(p_lat, p_lng, c.lat, c.lng) <= p_radius_meters
  ORDER BY
    has_job DESC,
    distance_meters ASC,
    lower(c.last_name) ASC,
    lower(c.first_name) ASC
  LIMIT 1;

  IF v_cand IS NULL THEN
    INSERT INTO public.gps_match_log
      (business_id, input_lat, input_lng, team_code, stop_date, matched_client_id, matched_job_id, distance_meters, confidence)
    VALUES
      (p_business_id, p_lat, p_lng, p_team_code, p_date, NULL, NULL, NULL, 'none')
    RETURNING id INTO v_log_id;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::double precision, 'none'::text, v_log_id;
    RETURN;
  END IF;

  INSERT INTO public.gps_match_log
    (business_id, input_lat, input_lng, team_code, stop_date, matched_client_id, matched_job_id, distance_meters, confidence)
  VALUES
    (p_business_id, p_lat, p_lng, p_team_code, p_date, v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence)
  RETURNING id INTO v_log_id;

  IF v_cand.confidence = 'none' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, v_cand.distance_meters, 'none'::text, v_log_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence, v_log_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, double precision) TO service_role;

-- ─── Per-tenant staged rollout flag ─────────────────────────────────
-- Defaults OFF for every tenant, including Manna. The polling EF always
-- resolves + logs regardless of this flag (dry-run data keeps flowing),
-- but only calls the write RPCs when it's true. Tom's instruction: verify
-- gps_match_log looks sane on real polling runs before enabling writes.
-- Flipping this is a one-line UPDATE, not a migration.
ALTER TABLE public.business_geotab_integrations
  ADD COLUMN gps_clock_writes_enabled boolean NOT NULL DEFAULT false;

-- ─── poll_geotab_runs ────────────────────────────────────────────────
-- One row per cron-triggered polling run, across all tenants (the EF
-- loops every active-integration tenant in one invocation). No
-- business_id -- this is an ops log, not tenant data. RLS enabled with
-- zero policies: nobody in the browser app needs this table for PR #2,
-- so it's locked to service_role (via the RPC below) and direct
-- postgres/SQL-editor access only.
CREATE TABLE public.poll_geotab_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz,
  tenants_processed integer NOT NULL DEFAULT 0,
  trips_processed   integer NOT NULL DEFAULT 0,
  matches           integer NOT NULL DEFAULT 0,
  misses            integer NOT NULL DEFAULT 0,
  errors            text,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.poll_geotab_runs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.record_poll_geotab_run(
  p_start_at          timestamptz,
  p_end_at            timestamptz,
  p_tenants_processed integer,
  p_trips_processed   integer,
  p_matches           integer,
  p_misses            integer,
  p_errors            text DEFAULT NULL
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.poll_geotab_runs
    (start_at, end_at, tenants_processed, trips_processed, matches, misses, errors)
  VALUES
    (p_start_at, p_end_at, p_tenants_processed, p_trips_processed, p_matches, p_misses, p_errors)
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION public.record_poll_geotab_run(timestamptz, timestamptz, integer, integer, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_poll_geotab_run(timestamptz, timestamptz, integer, integer, integer, integer, text) TO service_role;

-- ─── list_active_geotab_integrations ────────────────────────────────
-- Every tenant the polling EF should process this cycle. No
-- p_business_id param (unlike migration 072's readers) -- this one is
-- meant to enumerate ALL tenants, so there's nothing to tenant-scope;
-- service_role-only grant is the boundary instead.
CREATE OR REPLACE FUNCTION public.list_active_geotab_integrations()
RETURNS TABLE(
  business_id             uuid,
  server                  text,
  database                text,
  username                text,
  password                text,
  gps_clock_writes_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT g.business_id, g.server, g.database, g.username, g.password, g.gps_clock_writes_enabled
  FROM   public.business_geotab_integrations g
  WHERE  g.status = 'active';
$$;

REVOKE ALL ON FUNCTION public.list_active_geotab_integrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_active_geotab_integrations() TO service_role;

-- ─── get_business_offices_for_polling ───────────────────────────────
-- Office coords + radius (for depot arrival/departure) and each
-- office's team list (for device-name matching) in one call.
CREATE OR REPLACE FUNCTION public.get_business_offices_for_polling(
  p_business_id uuid
) RETURNS TABLE(
  id         uuid,
  name       text,
  lat        double precision,
  lng        double precision,
  radius_km  numeric,
  teams      text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.name, o.lat, o.lng, o.radius_km, o.teams
  FROM   public.business_offices o
  WHERE  o.business_id = p_business_id
    AND  o.active = true
    AND  o.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.get_business_offices_for_polling(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_business_offices_for_polling(uuid) TO service_role;

-- ─── write_job_gps_clock ─────────────────────────────────────────────
-- Stamps the gps_match_log row with what event this was (always, for
-- dry-run visibility + PR #3), then writes jobs.actual_start_at /
-- actual_end_at ONLY if that column is currently NULL and the tenant
-- has gps_clock_writes_enabled -- never overwrites a manual clock.
-- actual_start_by/actual_end_by are deliberately left NULL on a GPS
-- write: that NULL is the signal downstream that this timestamp came
-- from GPS, not a team-leader tap (set_job_actual_time, migration 032,
-- always sets an employee id).
-- Returns true if the jobs table was actually written.
CREATE OR REPLACE FUNCTION public.write_job_gps_clock(
  p_business_id  uuid,
  p_job_id       uuid,
  p_mode         text,
  p_gps_at       timestamptz,
  p_match_log_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_writes_enabled boolean;
  v_wrote          boolean := false;
BEGIN
  IF p_mode NOT IN ('start','end') THEN
    RAISE EXCEPTION 'Invalid mode: %', p_mode;
  END IF;

  UPDATE public.gps_match_log
  SET gps_event_type = 'job_' || p_mode,
      gps_event_at   = p_gps_at
  WHERE id = p_match_log_id;

  SELECT gps_clock_writes_enabled INTO v_writes_enabled
  FROM public.business_geotab_integrations
  WHERE business_id = p_business_id;

  IF NOT COALESCE(v_writes_enabled, false) THEN
    RETURN false;
  END IF;

  IF p_mode = 'start' THEN
    UPDATE public.jobs
    SET actual_start_at = p_gps_at
    WHERE id = p_job_id AND business_id = p_business_id AND actual_start_at IS NULL;
  ELSE
    UPDATE public.jobs
    SET actual_end_at = p_gps_at
    WHERE id = p_job_id AND business_id = p_business_id AND actual_end_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_wrote = ROW_COUNT;
  RETURN v_wrote;
END;
$$;

REVOKE ALL ON FUNCTION public.write_job_gps_clock(uuid, uuid, text, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_job_gps_clock(uuid, uuid, text, timestamptz, uuid) TO service_role;

-- ─── write_office_gps_clock ──────────────────────────────────────────
-- Payroll office entry/exit. Design choice, flagged explicitly: Geotab
-- tracks one device per TEAM (a vehicle), but time_entries is per
-- EMPLOYEE -- there's no 1:1 device-to-employee mapping anywhere in
-- this schema. This writes one time_entries row per employee on
-- daily_assignments for that business+date+team, all sharing the same
-- GPS-derived timestamp (the team rode in the same tracked vehicle).
-- If that's not the semantics you want (e.g. a single team-level
-- record instead), this is the function to change.
--
-- mode='start' (morning office departure): for each team member with no
--   existing time_entries row that day (manual or otherwise), insert one
--   with clock_in_at = p_gps_at. Never touches an employee who already
--   has a row for the day.
-- mode='end' (evening office return): for each team member's OPEN row
--   that day (clock_out_at IS NULL), set clock_out_at = p_gps_at, but
--   only if it's still NULL -- never overwrites a manual clock-out.
-- Gated by gps_clock_writes_enabled same as write_job_gps_clock.
-- Returns the number of time_entries rows written/updated.
CREATE OR REPLACE FUNCTION public.write_office_gps_clock(
  p_business_id uuid,
  p_team_code   text,
  p_date        date,
  p_mode        text,
  p_gps_at      timestamptz,
  p_lat         double precision,
  p_lng         double precision
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_writes_enabled boolean;
  v_count          integer := 0;
BEGIN
  IF p_mode NOT IN ('start','end') THEN
    RAISE EXCEPTION 'Invalid mode: %', p_mode;
  END IF;

  SELECT gps_clock_writes_enabled INTO v_writes_enabled
  FROM public.business_geotab_integrations
  WHERE business_id = p_business_id;

  IF NOT COALESCE(v_writes_enabled, false) THEN
    RETURN 0;
  END IF;

  IF p_mode = 'start' THEN
    INSERT INTO public.time_entries (business_id, employee_id, clock_in_at, clock_in_lat, clock_in_lng)
    SELECT p_business_id, da.employee_id, p_gps_at, p_lat, p_lng
    FROM public.daily_assignments da
    WHERE da.business_id = p_business_id
      AND da.date = p_date
      AND da.team = p_team_code
      AND da.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.time_entries te
        WHERE te.employee_id = da.employee_id
          AND te.business_id = p_business_id
          AND te.clock_in_at::date = p_date
          AND te.deleted_at IS NULL
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    UPDATE public.time_entries te
    SET clock_out_at = p_gps_at, clock_out_lat = p_lat, clock_out_lng = p_lng
    FROM public.daily_assignments da
    WHERE da.business_id = p_business_id
      AND da.date = p_date
      AND da.team = p_team_code
      AND da.deleted_at IS NULL
      AND te.employee_id = da.employee_id
      AND te.business_id = p_business_id
      AND te.clock_in_at::date = p_date
      AND te.clock_out_at IS NULL
      AND te.deleted_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.write_office_gps_clock(uuid, text, date, text, timestamptz, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_office_gps_clock(uuid, text, date, text, timestamptz, double precision, double precision) TO service_role;

-- ─── pg_cron -> Edge Function trigger ───────────────────────────────
-- Needs the project's service_role key to authenticate the HTTP call
-- (poll-geotab-clocks keeps verify_jwt=true and checks the decoded
-- role claim is 'service_role' -- same posture as every other
-- service_role-only surface in this project, not weakened for cron's
-- sake). That key isn't obtainable through migration tooling by design
-- -- it has to be seeded into Vault once, manually, by someone with
-- dashboard/SQL-editor access. See the PR description for the exact
-- one-line statement to run.
--
-- Until that secret exists, this no-ops with a warning every 15 min
-- rather than hard-failing -- cheap (one vault lookup), and scheduling
-- it now means the job is live the moment the secret is seeded, with
-- no second deploy needed.
CREATE OR REPLACE FUNCTION public.trigger_poll_geotab_clocks()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp, vault, net
AS $$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF v_key IS NULL THEN
    RAISE WARNING 'trigger_poll_geotab_clocks: service_role_key not seeded in Vault yet, skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := 'https://wymoezilyjmyibmuqqmr.supabase.co/functions/v1/poll-geotab-clocks',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_poll_geotab_clocks() FROM PUBLIC;
