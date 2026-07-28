-- GPS-as-truth clock-in/out: full trip-id idempotency (Tom's explicit
-- follow-up ask after the scoped-down version in migration 078).
--
-- Key insight: a single Geotab Trip record contributes up to TWO
-- distinct logical events -- its stopPoint (arrival at wherever the
-- vehicle just parked) and its startPoint (departure from wherever it
-- just left). Both need their own idempotency key: (business_id,
-- device_id, trip_id, point_type), point_type in ('start','stop').
--
-- resolve_job_from_gps_stop now checks for an existing gps_match_log
-- row under that key BEFORE doing any matching work. On replay (same
-- trip+point re-seen in an overlapping poll window), it returns the
-- exact same result from the first resolution -- no re-match, no new
-- log row, and the caller's downstream write_job_gps_clock call is a
-- guaranteed no-op re-attempt of the same already-decided outcome
-- (which was already safe via the NULL-check, but now truly identical
-- rather than independently re-derived).
--
-- The office bookend path (write_office_gps_clock) deliberately does
-- NOT get trip-id keying here: its existing employee+day+source='gps'
-- guard is already an equally strong dedup key for that path (there's
-- only ever one legitimate office-arrival and one office-departure per
-- employee per day, so keying by day is not weaker than keying by
-- trip). Adding trip-id there would be redundant, not safer.

ALTER TABLE public.gps_match_log
  ADD COLUMN geotab_device_id text,
  ADD COLUMN geotab_trip_id   text,
  ADD COLUMN geotab_point_type text CHECK (geotab_point_type IN ('start','stop'));

CREATE UNIQUE INDEX gps_match_log_trip_idempotency_idx
  ON public.gps_match_log (business_id, geotab_device_id, geotab_trip_id, geotab_point_type)
  WHERE geotab_trip_id IS NOT NULL;

DROP FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, timestamptz, double precision);

CREATE OR REPLACE FUNCTION public.resolve_job_from_gps_stop(
  p_business_id    uuid,
  p_lat            double precision,
  p_lng            double precision,
  p_date           date,
  p_team_code      text,
  p_event_at       timestamptz,
  p_device_id      text,
  p_geotab_trip_id text,
  p_point_type     text,
  p_radius_meters  double precision DEFAULT 61
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
  v_existing  RECORD;
  v_cand      RECORD;
  v_runner_up RECORD;
  v_log_id    uuid;
  v_local_t   time;
  v_notes     text := NULL;
  v_ambig     boolean := false;
BEGIN
  IF p_point_type NOT IN ('start','stop') THEN
    RAISE EXCEPTION 'Invalid point_type: %', p_point_type;
  END IF;

  -- Idempotent replay: this exact trip+point was already resolved by an
  -- earlier poll (overlapping window, manual re-trigger shortly after
  -- cron, etc). Return the prior outcome verbatim -- no re-match, no
  -- new log row, no chance of a second write downstream.
  IF p_geotab_trip_id IS NOT NULL THEN
    -- Table alias + qualified columns: distance_meters/confidence
    -- collide with this function's own RETURNS TABLE output-parameter
    -- names (PL/pgSQL implicitly scopes those as variables through the
    -- whole function body), so an unqualified reference is ambiguous.
    SELECT l.id, l.matched_client_id, l.matched_job_id, l.distance_meters, l.confidence, l.notes
    INTO v_existing
    FROM public.gps_match_log l
    WHERE l.business_id       = p_business_id
      AND l.geotab_device_id  = p_device_id
      AND l.geotab_trip_id    = p_geotab_trip_id
      AND l.geotab_point_type = p_point_type
    LIMIT 1;

    -- v_existing.id (not "v_existing IS NOT NULL"): row/RECORD
    -- IS NOT NULL is true only when EVERY field is non-null. This log
    -- row's own `notes` is legitimately NULL on the non-ambiguous path,
    -- so "IS NOT NULL" on the whole record silently reads as "not
    -- found" even when the SELECT INTO succeeded -- caught live via a
    -- replay test that should have short-circuited and instead fell
    -- through to a duplicate INSERT, correctly blocked by the unique
    -- index but for the wrong reason (constraint violation, not a
    -- graceful early return). id is the PK, never null when a row was
    -- actually found, so it's the right field to test.
    IF v_existing.id IS NOT NULL THEN
      RETURN QUERY SELECT
        v_existing.matched_client_id, v_existing.matched_job_id, v_existing.distance_meters,
        v_existing.confidence, v_existing.id,
        (v_existing.notes IS NOT NULL AND v_existing.notes LIKE 'ambiguous:%');
      RETURN;
    END IF;
  END IF;

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
      (business_id, input_lat, input_lng, team_code, stop_date, matched_client_id, matched_job_id, distance_meters, confidence,
       geotab_device_id, geotab_trip_id, geotab_point_type)
    VALUES
      (p_business_id, p_lat, p_lng, p_team_code, p_date, NULL, NULL, NULL, 'none',
       p_device_id, p_geotab_trip_id, p_point_type)
    RETURNING id INTO v_log_id;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::double precision, 'none'::text, v_log_id, false;
    RETURN;
  END IF;

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
    (business_id, input_lat, input_lng, team_code, stop_date, matched_client_id, matched_job_id, distance_meters, confidence, notes,
     geotab_device_id, geotab_trip_id, geotab_point_type)
  VALUES
    (p_business_id, p_lat, p_lng, p_team_code, p_date, v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence, v_notes,
     p_device_id, p_geotab_trip_id, p_point_type)
  RETURNING id INTO v_log_id;

  IF v_cand.confidence = 'none' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, v_cand.distance_meters, 'none'::text, v_log_id, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence, v_log_id, v_ambig;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, timestamptz, text, text, text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, timestamptz, text, text, text, double precision) TO service_role;
