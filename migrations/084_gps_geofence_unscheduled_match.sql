-- Fix: Live Tracking flags real (but unscheduled) client visits as
-- "possible lunch/break" because resolve_job_from_gps_stop only ever
-- matched a client when a scheduled job existed for that team+date+
-- client. A team that stops at a client's house for a walk-through,
-- same-day add, or follow-up -- with no job row for that visit -- got
-- 'none' back and rendered as an unrecognized stop.
--
-- Root cause reported by Tom for one concrete case (1 Caulfield Rd,
-- Wayland / Susan Devlin): the client's stored address had a typo
-- ("Caulfied" instead of "Caulfield"), which is why lat/lng were never
-- geocoded (browser-side PentaGeocode never resolved it) -- separately
-- fixed by correcting the address + backfilling coordinates. But the
-- geofence resolver itself had a second, independent gap: even with
-- correct lat/lng, an UNSCHEDULED visit could never match at all,
-- because the old query only computed a candidate's distance/confidence
-- inside a single tight 61m (200ft) radius, and required a scheduled
-- job for anything beyond the closest 30m to register as anything but
-- 'none'.
--
-- New tiering (feet converted to meters: 200ft = 60.96m, 400ft = 121.92m):
--   high   -- within 200ft AND a scheduled job exists for that team/date
--   medium -- within 200ft, no scheduled job (unscheduled visit)
--   low    -- 200-400ft buffer zone, scheduled or not (looser GPS fix,
--             or an unscheduled visit slightly farther from the pin)
--   none   -- no client within 400ft
-- All tiers except 'none' are treated as a client match for stop
-- labeling; only 'none' should ever be flagged "possible lunch/break"
-- downstream. job_id is populated whenever a scheduled job exists,
-- independent of confidence tier -- confidence describes match
-- reliability, not schedule status.
--
-- Outer search radius widened from p_radius_meters default 61 (200ft)
-- to 121.92 (400ft) so the 'low' buffer tier is actually reachable;
-- the poll-geotab-clocks EF caller is updated separately (not in this
-- migration) to gate actual clock-in/out writes to confidence IN
-- ('high','medium') rather than bare job_id truthiness, so this wider
-- search radius doesn't loosen payroll-clock accuracy as a side effect
-- -- it only widens what Live Tracking can label.

CREATE OR REPLACE FUNCTION public.resolve_job_from_gps_stop(
  p_business_id     uuid,
  p_lat             double precision,
  p_lng             double precision,
  p_date            date,
  p_team_code       text,
  p_event_at        timestamptz,
  p_device_id       text,
  p_geotab_trip_id  text,
  p_point_type      text,
  p_radius_meters   double precision DEFAULT 121.92  -- 400ft outer buffer
) RETURNS TABLE(client_id uuid, job_id uuid, distance_meters double precision, confidence text, log_id uuid, ambiguous boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing     RECORD;
  v_cand         RECORD;
  v_runner_up    RECORD;
  v_log_id       uuid;
  v_local_t      time;
  v_notes        text := NULL;
  v_ambig        boolean := false;
  v_close_radius_m constant double precision := 60.96; -- 200ft: high/medium cutoff
BEGIN
  IF p_point_type NOT IN ('start','stop') THEN
    RAISE EXCEPTION 'Invalid point_type: %', p_point_type;
  END IF;

  IF p_geotab_trip_id IS NOT NULL THEN
    SELECT l.id, l.matched_client_id, l.matched_job_id, l.distance_meters, l.confidence, l.notes
    INTO v_existing
    FROM public.gps_match_log l
    WHERE l.business_id       = p_business_id
      AND l.geotab_device_id  = p_device_id
      AND l.geotab_trip_id    = p_geotab_trip_id
      AND l.geotab_point_type = p_point_type
    LIMIT 1;

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
      WHEN public.haversine_meters(p_lat, p_lng, c.lat, c.lng) <= v_close_radius_m AND j.id IS NOT NULL     THEN 'high'
      WHEN public.haversine_meters(p_lat, p_lng, c.lat, c.lng) <= v_close_radius_m AND j.id IS NULL         THEN 'medium'
      WHEN public.haversine_meters(p_lat, p_lng, c.lat, c.lng) <= p_radius_meters                            THEN 'low'
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
    -- Prefer the closest client first (distance is now the primary
    -- signal, since an unscheduled-but-closer client should win over a
    -- scheduled-but-farther one -- e.g. two neighbors, only one with a
    -- job today). has_job only breaks ties at equal distance.
    distance_meters ASC,
    has_job DESC,
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
$function$;
