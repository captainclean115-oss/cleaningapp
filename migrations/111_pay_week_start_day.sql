-- Pay week boundary is a per-business setting, not a hardcoded
-- convention. The GPS "Last week" filter (migration-adjacent PR #175)
-- and Claire's date resolution ("last week", "last Tuesday") both need
-- to agree on which day starts the pay week -- previously hardcoded to
-- Monday in the GPS filter's own code. Manna's pay week is Monday-Sunday
-- (confirmed directly with Tom), but a future tenant may run
-- Sunday-Saturday, so this needs to be editable per business, not
-- baked into application logic.
--
-- No data migration needed: this only changes how "last week" is
-- INTERPRETED going forward (a pure read-time setting), it doesn't
-- retag any existing rows.
ALTER TABLE public.businesses
  ADD COLUMN pay_week_start_day text NOT NULL DEFAULT 'monday'
  CHECK (pay_week_start_day IN ('sunday', 'monday'));
