-- GPS-as-truth clock-in/out, PR #1 of 3: SQL foundation.
--
-- New geofence matcher, deliberately separate from matchStopToClient
-- (index.html:28101) -- that function does address-STRING matching for
-- read-only display labels (Live Tracking map popups, Claire's
-- locate_team tool, lunch-gap exclusion). This is a NEW lat/lng-distance
-- matcher whose job is to decide whether to WRITE a job clock time.
-- Different purpose, different failure modes, so it stays a separate
-- function rather than reusing/altering the display one. A later PR can
-- migrate display callers onto this one if it proves more reliable.
--
-- Scope: forward-going only. No historical backfill -- team assignments
-- weren't tracked reliably before now, so backfilling old GPS trips
-- against today's team codes would attribute jobs to the wrong team and
-- poison later estimator training (PR #2 of the minutes work).

-- ─── haversine_meters ────────────────────────────────────────────────
-- Great-circle distance in meters between two lat/lng points. Plain SQL
-- (no PostGIS/earthdistance extension) per instruction to avoid adding
-- extensions when avoidable -- this is one formula, not worth the
-- dependency.
CREATE OR REPLACE FUNCTION public.haversine_meters(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 2 * 6371000 * asin(
    sqrt(
      sin(radians(lat2 - lat1) / 2) ^ 2 +
      cos(radians(lat1)) * cos(radians(lat2)) *
      sin(radians(lng2 - lng1) / 2) ^ 2
    )
  );
$$;

-- ─── gps_match_log ──────────────────────────────────────────────────
-- Every call to resolve_job_from_gps_stop logs here, match or not --
-- this is the training/tuning data for PR #2's polling loop and any
-- later radius/confidence-tier adjustments.
--
-- stop_date is additive beyond Tom's named field list (business_id,
-- timestamp, input_lat, input_lng, team_code, matched_client_id,
-- matched_job_id, distance_meters, confidence, notes) -- the resolver
-- takes a date as a required input and the log is far less useful for
-- tuning without it, so it's included as ts is the log-write time, not
-- the date the GPS stop pertains to.
CREATE TABLE public.gps_match_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES public.businesses(id),
  ts                timestamptz NOT NULL DEFAULT clock_timestamp(),
  input_lat         double precision NOT NULL,
  input_lng         double precision NOT NULL,
  team_code         text NOT NULL,
  stop_date         date NOT NULL,
  matched_client_id uuid REFERENCES public.clients(id),
  matched_job_id    uuid REFERENCES public.jobs(id),
  distance_meters   double precision,
  confidence        text NOT NULL CHECK (confidence IN ('high','medium','low','none')),
  notes             text
);

CREATE INDEX gps_match_log_business_ts_idx ON public.gps_match_log (business_id, ts DESC);
CREATE INDEX gps_match_log_client_idx ON public.gps_match_log (matched_client_id) WHERE matched_client_id IS NOT NULL;

ALTER TABLE public.gps_match_log ENABLE ROW LEVEL SECURITY;

-- Manager-tier read only. Written exclusively by resolve_job_from_gps_stop
-- (SECURITY DEFINER, below), so there is deliberately no INSERT/UPDATE/
-- DELETE policy -- same posture as client_health_scores (migration 071).
CREATE POLICY gps_match_log_select ON public.gps_match_log FOR SELECT
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid())
      IN ('owner','admin','manager','dispatcher')
);

GRANT SELECT ON public.gps_match_log TO authenticated;

-- ─── resolve_job_from_gps_stop ──────────────────────────────────────
-- SECURITY DEFINER + caller-supplied p_business_id is a tenant hole for
-- any user-facing surface (see migration 072) -- but this RPC has no
-- user-facing caller. It's invoked exclusively by the poll-geotab-clocks
-- Edge Function (PR #2) under service_role, with no user JWT in play, so
-- there's no authenticated caller to scope by. Granted to service_role
-- only, same posture as the migration-072 scoring RPCs.
--
-- Confidence tiers (Tom's spec):
--   high:   distance < 30m  AND a non-cancelled job is scheduled for
--           this client+team+date
--   medium: distance 30-61m AND a non-cancelled job is scheduled
--   low:    distance < 30m  but NO job scheduled (unscheduled stop --
--           flag rather than silently attribute)
--   none:   no client within the radius at all
--
-- Gap in the spec, resolved here: a stop 30-61m from a client with NO
-- scheduled job doesn't fit any listed tier. Treated as 'none' (not
-- returned as a match) -- at that distance, without a schedule anchor,
-- there's not enough signal to safely attribute the stop to one client
-- over a neighbor. The near-candidate is still logged (not discarded)
-- for tuning visibility, just not returned as an actionable match.
--
-- Ties among multiple candidates within radius: scheduled-job clients
-- win over unscheduled ones; among those, closer distance wins; ties on
-- distance break alphabetically by last name then first name.
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
  confidence      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cand RECORD;
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
      (p_business_id, p_lat, p_lng, p_team_code, p_date, NULL, NULL, NULL, 'none');
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::double precision, 'none'::text;
    RETURN;
  END IF;

  -- Log the candidate regardless of tier (tuning signal), but only
  -- return it as an actionable match when confidence isn't 'none'.
  INSERT INTO public.gps_match_log
    (business_id, input_lat, input_lng, team_code, stop_date, matched_client_id, matched_job_id, distance_meters, confidence)
  VALUES
    (p_business_id, p_lat, p_lng, p_team_code, p_date, v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence);

  IF v_cand.confidence = 'none' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, v_cand.distance_meters, 'none'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_cand.client_id, v_cand.job_id, v_cand.distance_meters, v_cand.confidence;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_job_from_gps_stop(uuid, double precision, double precision, date, text, double precision) TO service_role;
