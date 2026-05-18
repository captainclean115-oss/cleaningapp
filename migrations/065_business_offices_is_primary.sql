-- Make weather coords deterministic for multi-office tenants.
--
-- _resolveWeatherCoords() used to take business_offices[0] from
-- PentaOffices.listSync(). With no .order() clause and no primary flag,
-- the "first" office was whichever PostgREST happened to return first
-- (effectively created_at ASC). For Manna with two MA offices that's
-- harmless — but a tenant with offices in different climates (e.g. FL +
-- MA) would see whichever sorted first. Same risk for any other
-- "first office" decision the app might make later.
--
-- Add a boolean is_primary column with a partial unique index that
-- enforces exactly one primary per (business_id, NOT deleted). Backfill
-- the oldest active non-deleted office per tenant. The Admin UI gets a
-- "Set primary" button per office row; the browser does a two-step
-- UPDATE (clear old → set new) in that order so the partial unique
-- index never sees two primaries simultaneously.

ALTER TABLE public.business_offices
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false;

-- Backfill: oldest active non-deleted office per tenant becomes primary.
-- Tenants with zero active offices stay all-false (the weather widget
-- already handles that case gracefully).
UPDATE public.business_offices
SET    is_primary = true
WHERE  id IN (
  SELECT DISTINCT ON (business_id) id
  FROM   public.business_offices
  WHERE  deleted_at IS NULL
    AND  active = true
  ORDER  BY business_id, created_at ASC
);

-- Partial unique index — at most one primary per tenant, ignoring
-- soft-deleted rows. Lets a tenant flip primaries by clearing the old
-- one first (two-step UPDATE in the browser).
CREATE UNIQUE INDEX business_offices_one_primary_per_business
  ON public.business_offices (business_id)
  WHERE is_primary = true AND deleted_at IS NULL;
