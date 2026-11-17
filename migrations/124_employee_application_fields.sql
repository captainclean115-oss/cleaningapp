-- Hire-transfer-missing-fields fix. The hire step (hireApplicant) only
-- ever copied first/last name, phone, and email from a job application
-- into the new employee row -- every other field the applicant typed
-- (address, work authorization, availability, emergency contact, etc.)
-- was silently dropped, even though public.employees already has a
-- matching column for almost all of them and the Staff edit form /
-- employee profile view already read and wrote those columns for
-- manager-entered data.
--
-- Three application fields genuinely have nowhere to land on the
-- employee side at all -- added here. (public.employees.preferred_language
-- already exists as a column from an earlier migration but was never
-- wired into the PentaEmployees facade's read/write mapping -- that is
-- a code fix, not a schema one, so it needs no DDL here.)
--
-- Run twice safely: ADD COLUMN IF NOT EXISTS throughout.

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS has_reliable_transportation boolean,
  ADD COLUMN IF NOT EXISTS prior_employer text,
  ADD COLUMN IF NOT EXISTS earliest_start_date date;

COMMENT ON COLUMN public.employees.has_reliable_transportation IS 'From the job application''s "reliable transportation" question. Null for every employee hired before this migration, or hired any other way.';
COMMENT ON COLUMN public.employees.prior_employer IS 'From the job application''s prior-employer field. Null for every employee hired before this migration, or hired any other way.';
COMMENT ON COLUMN public.employees.earliest_start_date IS 'The date the applicant said she could start, from the job application. Distinct from hired_at (the date Tom actually approved the hire).';

-- No RLS policy changes needed: these are plain columns on an existing
-- RLS-enabled table (public.employees) -- Postgres RLS is row-level,
-- not column-level, so the existing policies already cover them.

-- ROLLBACK
-- ALTER TABLE public.employees
--   DROP COLUMN IF EXISTS has_reliable_transportation,
--   DROP COLUMN IF EXISTS prior_employer,
--   DROP COLUMN IF EXISTS earliest_start_date;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run after applying; see also tools/verify_124.sql)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='employees'
--   AND column_name IN ('has_reliable_transportation','prior_employer','earliest_start_date')
-- ORDER BY column_name;
