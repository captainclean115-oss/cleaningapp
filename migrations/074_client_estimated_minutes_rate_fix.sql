-- In-home minutes: correct the labor-rate assumption behind
-- clients.estimated_minutes (migration 073) from $60/hr to $70/hr, and
-- fix the underlying model. Tom's correction, 2026-07-27:
--
--   - $70/hr is a per-LABOR-HOUR rate, prorated across the team, not a
--     team-hour or per-cleaner-flat rate. Example: 4 cleaners x 4 clock
--     hours = 16 labor-hours = 960 labor-minutes = $1,120.
--   - clients.estimated_minutes stores TOTAL LABOR-MINUTES the house
--     needs -- invariant to team size. (This matches what migration 073
--     already built: it's the numerator in getJobDurationMins()'s
--     totalMins / team_size division -- only the backfill rate was
--     wrong, not the storage model.)
--
-- New formula: estimated_minutes = ROUND((price / 70) * 60 / 15) * 15
--   i.e. price/70 = labor-hours, x60 = labor-minutes, round to nearest 15.
--
-- This OVERWRITES the $60/hr backfill from migration 073 for every
-- Manna Maids client with priced job history, per Tom's explicit
-- instruction to re-run for all active clients (not just NULLs).
--
-- Still scoped to Manna Maids (48532f06-0625-415b-9091-2638bed6506d)
-- only -- same reasoning as 073: the rate is tenant-specific and there's
-- no generic per-tenant labor rate config. $70/hr is also the rate the
-- PR #2 smart estimator should assume once built (no estimator code
-- exists yet as of this migration).

WITH client_price AS (
  SELECT j.client_id AS external_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY j.price) AS median_price
  FROM   public.jobs j
  WHERE  j.business_id = '48532f06-0625-415b-9091-2638bed6506d'
    AND  j.price IS NOT NULL
    AND  j.price > 0
  GROUP  BY j.client_id
)
UPDATE public.clients c
SET    estimated_minutes = GREATEST(15, ROUND((cp.median_price / 70.0) * 60 / 15) * 15)
FROM   client_price cp
WHERE  c.business_id = '48532f06-0625-415b-9091-2638bed6506d'
  AND  c.external_id = cp.external_id;
