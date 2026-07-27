-- Client Health Scoring — Phase A.
--
-- Stores a 0-100 health score per active client, recomputed by the
-- `score-client-health` Edge Function. Append-only: one row per client
-- per scoring run, grouped by run_id. History is the point — the
-- sharp-drop alert compares a client's newest score against their
-- previous one, and a trend line needs more than "current".
--
-- ─── Why the factor set looks the way it does ──────────────────────
--
-- The original Phase A scope assumed behavioral signals (job
-- completion rate, cancellation rate, incidents, comms
-- responsiveness). A signal inventory against live data killed all of
-- them:
--
--   jobs.status          1916 of 1927 PAST jobs are still 'scheduled'.
--                        Only 4 'completed' rows exist, ever. The app
--                        never transitions job status, so completion
--                        rate is ~0.2% for every client alike.
--   cancellations        7 rows total across 346 clients.
--   incidents            2 rows.  job_issues: 3 rows.
--   messages/convos      0 rows — client SMS never landed in Postgres;
--                        it lives in RingCentral (see sms_tone below).
--   clients.balance      1 client nonzero.
--   avg_net_rev_per_job  0 populated.
--
-- And one active trap:
--
--   last_service_date / next_service_date LOOK like ideal inputs but
--   are stale CRM imports — all 327 last_service_date values are >90
--   days old and EVERY next_service_date is in the past. Scoring off
--   them renders all 327 clients as churning. Do not use them.
--
-- What is actually live is the jobs table (2205 priced jobs, 326
-- future jobs across 250 clients) and clients.frequency. So Phase A
-- scores on cadence adherence, revenue trend, and forward booking,
-- plus SMS tone pulled live from RingCentral at score time.
--
-- The dead behavioral factors are still WRITTEN into the factors
-- jsonb at weight 0. They cost nothing, they document why the score
-- is shaped this way, and when job-status transitions get fixed the
-- EF flips their weights on without a migration or a shape change.
--
-- ─── Scored set ────────────────────────────────────────────────────
--
-- status = 'active' AND deleted_at IS NULL  → 327 clients.
--
-- NOT clients.active — that boolean is vestigial and reads `true` for
-- all 346 rows including the 15 that are status='inactive'. The live
-- column is the client_status enum ('active','paused','inactive'),
-- which is what the Clients view filters on (index.html:13707) and
-- what every other exclusion check in the app uses (13608, 14852,
-- 15012, 24074). deleted_at is separate: 4 rows are soft-deleted while
-- still status='active'.

CREATE TABLE IF NOT EXISTS public.client_health_scores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  client_id   uuid        NOT NULL REFERENCES public.clients(id)    ON DELETE CASCADE,
  -- Groups every client scored in one EF invocation. Lets the UI show
  -- "as of run X" coherently and lets the drop query pair a client's
  -- two most recent runs without straddling a partial run.
  run_id      uuid        NOT NULL,
  score       smallint    NOT NULL CHECK (score BETWEEN 0 AND 100),
  band        text        NOT NULL CHECK (band IN ('healthy','watch','at_risk')),
  -- Per-factor breakdown: {factor: {weight, value, detail}}. value is
  -- 0..1 normalized, or null when the factor had no data to work with
  -- (dormant, or the client has no SMS thread). weight is the fraction
  -- applied in this run, so a historical row still explains itself
  -- after the weights are retuned.
  factors     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- One-line plain-English rationale shown on the client card.
  summary     text,
  -- clock_timestamp(), NOT now(). now() is the TRANSACTION timestamp, so
  -- two runs recorded inside one transaction land on the identical
  -- scored_at, and both the DISTINCT ON below and the lag() in the drop
  -- query then tie-break arbitrarily — the latest-score lookup silently
  -- returns the OLDER run. Caught in the migration smoke test.
  scored_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Latest-score-per-client lookup — the dashboard's hot path.
CREATE INDEX IF NOT EXISTS client_health_scores_client_recent_idx
  ON public.client_health_scores (business_id, client_id, scored_at DESC);

-- Whole-run reads ("show me the newest run") and run pairing.
CREATE INDEX IF NOT EXISTS client_health_scores_run_idx
  ON public.client_health_scores (business_id, run_id, scored_at DESC);

-- At-risk counts for the home-tile badge, without scanning healthy rows.
CREATE INDEX IF NOT EXISTS client_health_scores_at_risk_idx
  ON public.client_health_scores (business_id, scored_at DESC)
  WHERE band = 'at_risk';

ALTER TABLE public.client_health_scores ENABLE ROW LEVEL SECURITY;

-- Read-only to tenants. Scores are written exclusively by the EF under
-- service_role — there is no user-facing write path, so no INSERT or
-- UPDATE policy exists on purpose.
CREATE POLICY client_health_scores_select ON public.client_health_scores FOR SELECT
USING (business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid()));

GRANT SELECT ON public.client_health_scores TO authenticated;

-- ─── RPCs ──────────────────────────────────────────────────────────

-- ─── A note on SECURITY INVOKER for the three read functions ───────
--
-- These take a caller-supplied p_business_id. Under SECURITY DEFINER
-- they would run as the owner and bypass RLS, so any authenticated user
-- could pass ANOTHER tenant's uuid and read that tenant's client names
-- and scores — p_business_id would be the only thing standing between
-- tenants, and it is attacker-controlled.
--
-- client_health_scores and clients both carry RLS SELECT policies scoped
-- to the caller's business, so INVOKER makes RLS the actual privilege
-- boundary and demotes p_business_id to an ordinary filter.
--
-- record_client_health_run below is the exception and stays DEFINER: it
-- is the sole writer, there is deliberately no INSERT policy, and it is
-- granted to service_role only.

-- Newest score per client for a business, joined to the client's name
-- so the dashboard renders in one round trip. DISTINCT ON is the
-- cheapest "latest per group" here and rides the recent_idx directly.
--
-- Returns only clients that still qualify for scoring; a client paused
-- after their last run drops out of the list rather than showing a
-- stale score next to a PAUSED pill.
CREATE OR REPLACE FUNCTION public.get_latest_client_health(
  p_business_id uuid
)
RETURNS TABLE(
  client_id    uuid,
  first_name   text,
  last_name    text,
  score        smallint,
  band         text,
  factors      jsonb,
  summary      text,
  scored_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT ON (s.client_id)
         s.client_id, c.first_name, c.last_name,
         s.score, s.band, s.factors, s.summary, s.scored_at
  FROM   public.client_health_scores s
  JOIN   public.clients c ON c.id = s.client_id
  WHERE  s.business_id = p_business_id
    AND  c.status      = 'active'
    AND  c.deleted_at IS NULL
  ORDER  BY s.client_id, s.scored_at DESC, s.id DESC;
$$;

REVOKE ALL ON FUNCTION public.get_latest_client_health(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_latest_client_health(uuid) TO authenticated, service_role;

-- Count of at-risk clients in the newest run — feeds the home-tile
-- badge. Split out from the full fetch so the badge refresh on every
-- home render stays a single cheap aggregate instead of hauling 327
-- rows of factor jsonb across the wire.
CREATE OR REPLACE FUNCTION public.count_at_risk_clients(
  p_business_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int
  FROM   public.get_latest_client_health(p_business_id)
  WHERE  band = 'at_risk';
$$;

REVOKE ALL ON FUNCTION public.count_at_risk_clients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_at_risk_clients(uuid) TO authenticated, service_role;

-- Sharp-drop detection. Pairs each client's two most recent scores and
-- returns those whose score fell by at least p_min_drop points.
--
-- The original design keyed this off a completion/cancellation trend,
-- which the data can't support (see header). It runs off the composite
-- score instead, so it fires on the underlying cadence/revenue/tone
-- movement that actually exists.
--
-- Guards against firing on a client's FIRST run: the lag() is null
-- there, and null comparisons drop the row.
CREATE OR REPLACE FUNCTION public.get_client_health_drops(
  p_business_id uuid,
  p_min_drop    integer DEFAULT 15
)
RETURNS TABLE(
  client_id      uuid,
  first_name     text,
  last_name      text,
  current_score  smallint,
  previous_score smallint,
  drop_points    integer,
  current_band   text,
  scored_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH ranked AS (
    SELECT s.client_id, s.score, s.band, s.scored_at,
           lag(s.score) OVER (PARTITION BY s.client_id ORDER BY s.scored_at, s.id) AS prev_score,
           row_number()  OVER (PARTITION BY s.client_id ORDER BY s.scored_at DESC, s.id DESC) AS rn
    FROM   public.client_health_scores s
    WHERE  s.business_id = p_business_id
  )
  SELECT r.client_id, c.first_name, c.last_name,
         r.score, r.prev_score,
         (r.prev_score - r.score)::int,
         r.band, r.scored_at
  FROM   ranked r
  JOIN   public.clients c ON c.id = r.client_id
  WHERE  r.rn = 1
    AND  r.prev_score IS NOT NULL
    AND  (r.prev_score - r.score) >= p_min_drop
    AND  c.status     = 'active'
    AND  c.deleted_at IS NULL
  ORDER  BY (r.prev_score - r.score) DESC;
$$;

REVOKE ALL ON FUNCTION public.get_client_health_drops(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_client_health_drops(uuid, integer) TO authenticated, service_role;

-- Bulk-insert one scoring run. The EF hands over the whole run as a
-- jsonb array so 327 clients land in one statement inside one
-- transaction — a partially-written run would corrupt the drop query,
-- which assumes the newest run is complete.
--
-- Service-role only; this is the sole write path to the table.
CREATE OR REPLACE FUNCTION public.record_client_health_run(
  p_business_id uuid,
  p_run_id      uuid,
  p_scores      jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO public.client_health_scores
      (business_id, client_id, run_id, score, band, factors, summary)
  SELECT p_business_id,
         (e->>'client_id')::uuid,
         p_run_id,
         (e->>'score')::smallint,
         e->>'band',
         COALESCE(e->'factors', '{}'::jsonb),
         e->>'summary'
  FROM   jsonb_array_elements(p_scores) AS e;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_client_health_run(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_client_health_run(uuid, uuid, jsonb) TO service_role;

-- ─── Config ────────────────────────────────────────────────────────
--
-- Admin control lives in businesses.business_settings->'client_health'
-- rather than a new table — business_settings is already jsonb NOT
-- NULL and currently {} for every tenant, and this is per-tenant
-- feature config, not relational data.
--
-- Shape:
--   { "enabled": bool,
--     "weights": { factor: fraction, ... },   -- must sum to 1.0
--     "drop_threshold": int,                  -- points, sharp-drop alert
--     "sms_lookback_months": int }            -- 1-12, clamped by rc-inbox
--
-- Seeded with the Phase A defaults. jsonb_set with create_if_missing
-- so re-running is a no-op on tenants that already tuned theirs.
UPDATE public.businesses
SET    business_settings = jsonb_set(
         COALESCE(business_settings, '{}'::jsonb),
         '{client_health}',
         '{
            "enabled": true,
            "weights": {
              "cadence_adherence": 0.35,
              "sms_tone":          0.25,
              "revenue_trend":     0.20,
              "forward_booking":   0.20,
              "completion_rate":   0.0,
              "cancel_rate":       0.0,
              "incident_rate":     0.0
            },
            "drop_threshold": 15,
            "sms_lookback_months": 3
          }'::jsonb,
         true
       )
WHERE  business_settings->'client_health' IS NULL;
