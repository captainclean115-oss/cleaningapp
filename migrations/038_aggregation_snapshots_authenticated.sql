-- v11.0.0 Item 4 — Restrict aggregation_snapshots SELECT to authenticated.
--
-- aggregation_snapshots is platform-wide rolled-up benchmark data
-- (metric_name, snapshot_date, geographic_bucket, vertical, business
-- size bucket, sample_size, value, distribution). It has no business_id
-- column by design — the whole point is anonymized cross-tenant
-- rollups so a signed-in operator can compare their numbers to "all
-- businesses in their metro" without exposing any individual tenant.
--
-- The existing policy was `qual = true` with role = PUBLIC, which
-- includes anon. There's no product requirement for unauthenticated
-- access to platform benchmarks today — and exposing benchmarks
-- anonymously could leak business signal to scrapers / competitors.
-- Tighten to `authenticated` only.
--
-- All other CRUD on this table has no policy, so service_role is the
-- only writer (intended — these snapshots are generated server-side).

DROP POLICY IF EXISTS aggregation_snapshots_select ON public.aggregation_snapshots;

CREATE POLICY aggregation_snapshots_select ON public.aggregation_snapshots
FOR SELECT
TO authenticated
USING (true);
