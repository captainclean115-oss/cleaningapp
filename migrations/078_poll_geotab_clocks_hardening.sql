-- GPS-as-truth clock-in/out: hardening pass on PR #2, per Tom's answers
-- to the three open design questions (time basis, overlapping-stop
-- matching, write-vs-alert ordering) plus a manual poll trigger and
-- guardrails (rate limit, failure alerting, idempotency posture).
--
-- Real bug found and fixed while implementing this: list_active_geotab_
-- integrations (migration 076) filtered `WHERE status = 'active'`. That
-- is EXACTLY the cascade-lockout bug migration 068 already fixed on the
-- sibling get_active_geotab_integration function: mark_geotab_
-- integration_error flips status to 'error' on any transient auth
-- blip, and a status filter then hides the row from every subsequent
-- call forever, until someone manually re-saves credentials. Dropping
-- the filter here too, matching 068's fix -- otherwise the new
-- consecutive-failure alerting below would talk itself into a permanent
-- lockout the first time it fires.

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
  WHERE  g.deleted_at IS NULL;
$$;

-- ─── Failure-streak tracking ─────────────────────────────────────────
-- Reuses the EXISTING admin-surfaced health/error mechanism
-- (mark_geotab_integration_error, migration 067 -- same "Admin -> Fleet
-- Tracking" hint geotab-call already shows) rather than building new
-- alert infrastructure. 3 consecutive polling failures for a tenant
-- flips the same status/last_error fields interactive calls already
-- use.
ALTER TABLE public.business_geotab_integrations
  ADD COLUMN consecutive_poll_failures integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.mark_geotab_integration_used(
  p_business_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.business_geotab_integrations
  SET    last_used_at              = now(),
         status                    = 'active',
         last_error                = NULL,
         consecutive_poll_failures = 0,
         updated_at                = now()
  WHERE  business_id  = p_business_id
    AND  deleted_at   IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_geotab_poll_failure(
  p_business_id uuid,
  p_error       text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.business_geotab_integrations
  SET    consecutive_poll_failures = consecutive_poll_failures + 1,
         updated_at                = now()
  WHERE  business_id = p_business_id
    AND  deleted_at  IS NULL
  RETURNING consecutive_poll_failures INTO v_count;

  IF v_count >= 3 THEN
    PERFORM public.mark_geotab_integration_error(p_business_id, 'poll-geotab-clocks: ' || v_count || ' consecutive failures. Last error: ' || LEFT(p_error, 400));
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_geotab_poll_failure(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_geotab_poll_failure(uuid, text) TO service_role;

-- ─── time_entries: GPS and manual as separate, comparable rows ──────
-- Tom's call on write-vs-alert ordering: don't make GPS and manual
-- fight over one row. Store both, tagged by source, so a divergence
-- check (PR #3) has two real data points to compare instead of one
-- value that only ever reflects whichever source wrote first.
ALTER TABLE public.time_entries
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('gps','manual'));

-- ─── poll_geotab_runs: trigger provenance + outcome breakdown ───────
ALTER TABLE public.poll_geotab_runs
  ADD COLUMN trigger               text NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron','manual')),
  ADD COLUMN jobs_newly_clocked    integer NOT NULL DEFAULT 0,
  ADD COLUMN jobs_skipped_existing integer NOT NULL DEFAULT 0,
  ADD COLUMN jobs_divergent        integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.record_poll_geotab_run(
  p_start_at             timestamptz,
  p_end_at               timestamptz,
  p_tenants_processed    integer,
  p_trips_processed      integer,
  p_matches              integer,
  p_misses               integer,
  p_errors               text DEFAULT NULL,
  p_trigger               text DEFAULT 'cron',
  p_jobs_newly_clocked    integer DEFAULT 0,
  p_jobs_skipped_existing integer DEFAULT 0,
  p_jobs_divergent        integer DEFAULT 0
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.poll_geotab_runs
    (start_at, end_at, tenants_processed, trips_processed, matches, misses, errors,
     trigger, jobs_newly_clocked, jobs_skipped_existing, jobs_divergent)
  VALUES
    (p_start_at, p_end_at, p_tenants_processed, p_trips_processed, p_matches, p_misses, p_errors,
     p_trigger, p_jobs_newly_clocked, p_jobs_skipped_existing, p_jobs_divergent)
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION public.record_poll_geotab_run(timestamptz, timestamptz, integer, integer, integer, integer, text, text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_poll_geotab_run(timestamptz, timestamptz, integer, integer, integer, integer, text, text, integer, integer, integer) TO service_role;

-- ─── resolve_job_from_gps_stop: closest-scheduled-time tie-break ────
-- Tom's call on overlapping stops: if a client somehow has more than
-- one non-cancelled job for this team+date (double-booking, rare but
-- possible), prefer whichever job's scheduled `time` is closest to the
-- actual GPS event moment (p_event_at), not just the first row Postgres
-- happens to return. jobs.time is business-local "HH:MM" text (or
-- empty for flexible bookings); compared against p_event_at converted
-- to America/New_York local time, same hardcoded-TZ convention as PR
-- #2's Edge Function.
--
-- Ambiguity flag: separately from picking the winner, check whether a
-- DIFFERENT client also has a scheduled job within the radius, close
-- enough to be a real contender. If so, note it rather than silently
-- picking -- per Tom: "log ambiguity... do NOT auto-write to the second
-- job." The winner is still written; the runner-up is visible in
-- gps_match_log.notes for manual review.
DROP FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, double precision);

CREATE OR REPLACE FUNCTION public.resolve_job_from_gps_stop(
  p_business_id   uuid,
  p_lat           double precision,
  p_lng           double precision,
  p_date          date,
  p_team_code     text,
  p_event_at      timestamptz,
  p_radius_meters double precision DEFAULT 61
) RETURNS TABLE(
  client_id       uuid,
  job_id          uuid,
  distance_meters double precision,
  confidence      text,
  log_id          uuid,
  ambiguous       boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cand      RECORD;
  v_runner_up RECORD;
  v_log_id    uuid;
  v_local_t   time;
  v_notes     text := NULL;
  v_ambig     boolean := false;
BEGIN
  v_local_t := (p_event_at AT TIME ZONE 'America/New_York')::time;

  SELECT
    c.id                                                          AS client_id,
    j.id                                                          AS job_id,
    c.first_name, c.last_name,
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
  LEFT JOIN LATERAL (
    SELECT j.* FROM public.jobs j
    WHERE  j.business_id = p_business_id
      AND  j.client_id   = c.external_id
      AND  j.date        = p_date
      AND  upper(j.team)  = upper(p_team_code)
      AND  j.status      <> 'cancelled'
    ORDER BY
      CASE WHEN j.time IS NULL OR j.time = '' THEN 1 ELSE 0 END,
      abs(extract(epoch FROM (NULLIF(j.time,'')::time - v_local_t))) ASC NULLS LAST
    LIMIT 1
  ) j ON true
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
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::double precision, 'none'::text, v_log_id, false;
    RETURN;
  END IF;

  -- Ambiguity check: a different client, also scheduled, also within
  -- radius, close enough to be a real contender (within 20m of the
  -- winner's distance). Doesn't change the winner -- diagnostic only.
  IF v_cand.confidence IN ('high','medium') THEN
    SELECT c2.first_name, c2.last_name, public.haversine_meters(p_lat, p_lng, c2.lat, c2.lng) AS d
    INTO v_runner_up
    FROM public.clients c2
    JOIN public.jobs j2
      ON j2.business_id = p_business_id
     AND j2.client_id   = c2.external_id
     AND j2.date        = p_date
     AND upper(j2.team)  = upper(p_team_code)
     AND j2.status      <> 'cancelled'
    WHERE c2.business_id = p_business_id
      AND c2.id          <> v_cand.client_id
      AND c2.status      = 'active'
      AND c2.deleted_at IS NULL
      AND c2.lat IS NOT NULL AND c2.lng IS NOT NULL
      AND public.haversine_meters(p_lat, p_lng, c2.lat, c2.lng) <= p_radius_meters
      AND public.haversine_meters(p_lat, p_lng, c2.lat, c2.lng) <= v_cand.distance_meters + 20
    ORDER BY d ASC
    LIMIT 1;

    IF v_runner_up IS NOT NULL THEN
      v_ambig := true;
      v_notes := 'ambiguous: also scheduled nearby -- ' || v_runner_up.first_name || ' ' || v_runner_up.last_name || ' (' || round(v_runner_up.d::numeric,1) || 'm)';
    END IF;
  END IF;

  INSERT INTO public.gps_match_log
    (business_id, input_lat, input_lng, team_code, stop_date, matched_client_id, matched_job_id, distance_meters, confidence, notes)
  VALUES
    (p_business_id, p_lat, p_lng, p_team_code, p_date, v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence, v_notes)
  RETURNING id INTO v_log_id;

  IF v_cand.confidence = 'none' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, v_cand.distance_meters, 'none'::text, v_log_id, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence, v_log_id, v_ambig;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, timestamptz, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, timestamptz, double precision) TO service_role;

-- ─── write_job_gps_clock: report divergence for run summaries ───────
-- Same never-overwrite-manual guard as before. Now also reports whether
-- the column was already set (skipped) and, if so, how far off the GPS
-- time was from the existing value -- feeds poll_geotab_runs' summary
-- counts. This previews PR #3's divergence math but does not alert;
-- PR #3 still owns the trigger + audit_log write for real alerting.
DROP FUNCTION public.write_job_gps_clock(uuid, uuid, text, timestamptz, uuid);

CREATE OR REPLACE FUNCTION public.write_job_gps_clock(
  p_business_id  uuid,
  p_job_id       uuid,
  p_mode         text,
  p_gps_at       timestamptz,
  p_match_log_id uuid
) RETURNS TABLE(
  did_write        boolean,
  skipped_existing boolean,
  divergent_minutes numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_writes_enabled boolean;
  v_existing       timestamptz;
  v_wrote          boolean := false;
BEGIN
  IF p_mode NOT IN ('start','end') THEN
    RAISE EXCEPTION 'Invalid mode: %', p_mode;
  END IF;

  UPDATE public.gps_match_log
  SET gps_event_type = 'job_' || p_mode,
      gps_event_at   = p_gps_at
  WHERE id = p_match_log_id;

  IF p_mode = 'start' THEN
    SELECT actual_start_at INTO v_existing FROM public.jobs WHERE id = p_job_id AND business_id = p_business_id;
  ELSE
    SELECT actual_end_at INTO v_existing FROM public.jobs WHERE id = p_job_id AND business_id = p_business_id;
  END IF;

  SELECT gps_clock_writes_enabled INTO v_writes_enabled
  FROM public.business_geotab_integrations
  WHERE business_id = p_business_id;

  IF NOT COALESCE(v_writes_enabled, false) THEN
    RETURN QUERY SELECT false, (v_existing IS NOT NULL),
      CASE WHEN v_existing IS NOT NULL THEN round(abs(extract(epoch FROM (v_existing - p_gps_at)) / 60)::numeric, 1) ELSE NULL END;
    RETURN;
  END IF;

  IF p_mode = 'start' THEN
    UPDATE public.jobs SET actual_start_at = p_gps_at
    WHERE id = p_job_id AND business_id = p_business_id AND actual_start_at IS NULL;
  ELSE
    UPDATE public.jobs SET actual_end_at = p_gps_at
    WHERE id = p_job_id AND business_id = p_business_id AND actual_end_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_wrote = ROW_COUNT;

  RETURN QUERY SELECT v_wrote, (v_existing IS NOT NULL),
    CASE WHEN v_existing IS NOT NULL THEN round(abs(extract(epoch FROM (v_existing - p_gps_at)) / 60)::numeric, 1) ELSE NULL END;
END;
$$;

REVOKE ALL ON FUNCTION public.write_job_gps_clock(uuid, uuid, text, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.write_job_gps_clock(uuid, uuid, text, timestamptz, uuid) TO service_role;

-- ─── write_office_gps_clock: GPS rows separate from manual rows ─────
-- Idempotency note: dedup is "no existing SOURCE='gps' row yet for this
-- employee+date" (start) / "no existing OPEN gps row yet" (end) --
-- deliberately not a full geotab-trip-id unique constraint. A tenant
-- would need to be polled twice for the exact same office event before
-- this guard applies, and the 5-minute per-tenant rate limit (enforced
-- in the Edge Function) plus the 15-minute cron cadence make that
-- exceedingly unlikely. Flagged as a scoped-down guardrail, not an
-- oversight -- full trip-id dedup can be added later if double-inserts
-- actually show up in practice.
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
    INSERT INTO public.time_entries (business_id, employee_id, clock_in_at, clock_in_lat, clock_in_lng, source)
    SELECT p_business_id, da.employee_id, p_gps_at, p_lat, p_lng, 'gps'
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
          AND te.source = 'gps'
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
      AND te.source = 'gps'
      AND te.clock_out_at IS NULL
      AND te.deleted_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  RETURN v_count;
END;
$$;
