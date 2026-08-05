-- 091 — gps_verification_start_date scaffolding (PR #86).
--
-- Deferred GPS-vs-completed-job cross-check: once Manna flips to Penta
-- as source of truth, jobs marked completed on or after this date
-- should be checked against gps_match_log for a matching GPS record
-- and flagged for review if none exists. Before this date is set (or
-- for jobs before it), no reliable GPS-to-job attribution exists --
-- Tom wasn't running Penta operationally pre-cutover, so absence of a
-- GPS match proves nothing.
--
-- This migration adds ONLY the column. The actual cross-check job
-- (end-of-day run, surfacing discrepancies somewhere -- "Open Items"
-- doesn't exist as a concept in this app yet) is real future work,
-- not built here -- see docs/06-technical-architecture.md for the
-- explicit scope note. NULL (the default) means "not set, no
-- cross-check applies," matching the deferred/off-by-default pattern
-- already used for the GPS geofence clock-in/out feature.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS gps_verification_start_date date;

COMMENT ON COLUMN public.businesses.gps_verification_start_date IS 'Date from which completed jobs should be cross-checked against gps_match_log (deferred feature, not yet built -- this column is scaffolding only). NULL = not set, no cross-check.';
