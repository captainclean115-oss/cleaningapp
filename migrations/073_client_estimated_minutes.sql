-- In-home minutes, PR #1: clients.estimated_minutes.
--
-- Tom's spec: a client-level "quoted minutes" field that jobs inherit at
-- creation time and the schedule board divides by team size to size the
-- block. Backfilled from each client's typical job price at a $60/hr rate
-- ($1/min exactly), rounded to the nearest 15 minutes -- Tom's own worked
-- examples ($180 -> 180min, $120 -> 120min) confirm this rate, which is
-- distinct from the $210/team-of-3 billing rate mentioned separately.
--
-- Scoped to Manna Maids (48532f06-0625-415b-9091-2638bed6506d) only: the
-- $60/hr rate is tenant-specific and there is no generic per-tenant labor
-- rate config to backfill other tenants from. New tenants/clients get
-- estimated_minutes set explicitly (client-card field, PR #1) or fall back
-- to the existing clientExtras/120-minute chain at read time.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS estimated_minutes integer;

COMMENT ON COLUMN public.clients.estimated_minutes IS
  'Quoted in-home minutes for a full team clean. Divided by team size at job creation/schedule-render time. NULL = no quote set yet, falls back to clientExtras/120.';

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
SET    estimated_minutes = GREATEST(15, ROUND(cp.median_price / 15.0) * 15)
FROM   client_price cp
WHERE  c.business_id = '48532f06-0625-415b-9091-2638bed6506d'
  AND  c.external_id = cp.external_id
  AND  c.estimated_minutes IS NULL;
