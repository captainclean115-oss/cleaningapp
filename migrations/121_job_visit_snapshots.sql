-- Stage 1 of the per-clean profitability feature (PR: visit-snapshots).
--
-- Context: Tom wants, per completed clean, (minutes the team was in the
-- home x each present employee's pay rate) compared to what the client
-- paid. A prior DIAGNOSE-ONLY pass found: no in-house GPS time is
-- stored per job today (jobs.actual_start_at/actual_end_at are null on
-- every row); jobs.status/done has not advanced since 2026-08-04 so it
-- cannot be used as a "did this happen" signal; employee_pay_history
-- exists but is unused (0 rows); business_payroll_settings has rows for
-- some businesses but is a SEPARATE concern from this. This migration
-- adds the two NEW tables that stage 1 needs. It does not touch jobs,
-- employees, the compute_job_actual_minutes trigger, or
-- gps_verification_start_date -- that existing mechanism is left OFF
-- and untouched; this feature is fully independent of it.
--
-- 1. job_visit_snapshots -- one row per job, built by a manager-
--    triggered tool (PR2, not yet built) from Geotab GPS + the existing
--    date-aware roster. NOT realtime, NOT live-computed -- a snapshot,
--    written once and (mostly) never overwritten. Employee pay rates
--    are FROZEN into the employees jsonb column at build time, not
--    looked up live, so a later pay-rate change never silently changes
--    a past clean's cost. No FK on the employee ids inside that jsonb
--    (per the task's own instruction -- an employee being edited or
--    removed later must never cascade into rewriting snapshot history).
--    No price column: the report always reads jobs.price live, so a
--    later price correction on the job is reflected automatically
--    without needing to touch this table.
--
-- 2. business_profit_targets -- one row per business, the "what's a
--    good number" comparison point for a future profit report (PR3+).
--    A missing row means "not set yet" -- the app falls back to a
--    hardcoded $70/hr default and treats the margin goal as unset; this
--    migration seeds nothing.
--
-- Both: owner/admin ONLY in RLS (SELECT/INSERT/UPDATE), matching the
-- task's explicit requirement -- stricter than this app's usual
-- manager-tier convention (business_payroll_settings, published_
-- employee_hours use owner/admin/manager/dispatcher). No DELETE policy
-- on either table -- rows are corrected by UPDATE (manually_edited=true
-- going forward), never deleted, so DELETE is left unimplemented.
--
-- Realtime: checked pg_publication_tables for supabase_realtime --
-- chat_messages, daily_assignments, employees, jobs, published_
-- employee_hours, and the reward_* tables are in it. But the one other
-- owner/admin-only, non-collaborative output/settings table in this
-- app -- business_payroll_settings (migration 117) -- was deliberately
-- NOT added to realtime. Both new tables here are the same shape (no
-- multi-user live view consumes them yet; PR2 hasn't been built), so
-- SKIPPING realtime for both, matching that nearer precedent rather
-- than the broader list. Revisit if a future PR needs live updates
-- while a build is in progress.
--
-- Run twice safely: IF NOT EXISTS / DROP POLICY IF EXISTS before CREATE
-- POLICY throughout.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. job_visit_snapshots
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.job_visit_snapshots (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id               uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  job_id                    uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- jobs.client_id is text (not a uuid FK to clients.id) throughout this
  -- app already -- stored the same way here, no FK, for consistency.
  client_id                 text,
  visit_date                date NOT NULL,
  team                      text,
  in_at                     timestamptz,
  out_at                    timestamptz,
  team_minutes              numeric CHECK (team_minutes IS NULL OR team_minutes >= 0),
  -- Array of {employee_id, minutes, rate_cents_per_hour, pay_type}.
  -- rate_cents_per_hour is the employee's pay_rate AT BUILD TIME, frozen
  -- -- never re-read live, never updated by a later pay-rate change.
  employees                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  labor_cost_gross_cents    integer CHECK (labor_cost_gross_cents IS NULL OR labor_cost_gross_cents >= 0),
  -- false when any PRESENT employee that day had no rate on file or is
  -- salaried -- that person is excluded from the sum above, and this
  -- flag says the total is a known undercount, never a silent one.
  labor_cost_complete       boolean NOT NULL DEFAULT true,
  status                    text NOT NULL CHECK (status IN ('matched', 'ambiguous', 'no_gps', 'unmatched', 'skipped')),
  match_note                text,
  manually_edited           boolean NOT NULL DEFAULT false,
  source                    text DEFAULT 'geotab',
  built_at                  timestamptz DEFAULT now(),
  built_by                  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE (business_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_visit_snapshots_business_date
  ON public.job_visit_snapshots (business_id, visit_date);

CREATE INDEX IF NOT EXISTS idx_job_visit_snapshots_business_client
  ON public.job_visit_snapshots (business_id, client_id);

ALTER TABLE public.job_visit_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_visit_snapshots_select ON public.job_visit_snapshots;
CREATE POLICY job_visit_snapshots_select ON public.job_visit_snapshots FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

DROP POLICY IF EXISTS job_visit_snapshots_insert ON public.job_visit_snapshots;
CREATE POLICY job_visit_snapshots_insert ON public.job_visit_snapshots FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

DROP POLICY IF EXISTS job_visit_snapshots_update ON public.job_visit_snapshots;
CREATE POLICY job_visit_snapshots_update ON public.job_visit_snapshots FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

GRANT SELECT, INSERT, UPDATE ON public.job_visit_snapshots TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. business_profit_targets
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.business_profit_targets (
  business_id                              uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  target_revenue_per_employee_hour_cents   integer NOT NULL DEFAULT 7000 CHECK (target_revenue_per_employee_hour_cents >= 0),
  target_margin_pct                        numeric CHECK (target_margin_pct IS NULL OR (target_margin_pct >= 0 AND target_margin_pct <= 100)),
  updated_at                                timestamptz NOT NULL DEFAULT now(),
  updated_by                                uuid REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.business_profit_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_profit_targets_select ON public.business_profit_targets;
CREATE POLICY business_profit_targets_select ON public.business_profit_targets FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

DROP POLICY IF EXISTS business_profit_targets_insert ON public.business_profit_targets;
CREATE POLICY business_profit_targets_insert ON public.business_profit_targets FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

DROP POLICY IF EXISTS business_profit_targets_update ON public.business_profit_targets;
CREATE POLICY business_profit_targets_update ON public.business_profit_targets FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

GRANT SELECT, INSERT, UPDATE ON public.business_profit_targets TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (not applied -- run this block to undo everything above)
-- ═══════════════════════════════════════════════════════════════════════
-- DROP POLICY IF EXISTS job_visit_snapshots_select ON public.job_visit_snapshots;
-- DROP POLICY IF EXISTS job_visit_snapshots_insert ON public.job_visit_snapshots;
-- DROP POLICY IF EXISTS job_visit_snapshots_update ON public.job_visit_snapshots;
-- DROP TABLE IF EXISTS public.job_visit_snapshots;
-- DROP POLICY IF EXISTS business_profit_targets_select ON public.business_profit_targets;
-- DROP POLICY IF EXISTS business_profit_targets_insert ON public.business_profit_targets;
-- DROP POLICY IF EXISTS business_profit_targets_update ON public.business_profit_targets;
-- DROP TABLE IF EXISTS public.business_profit_targets;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run after applying; see also tools/verify_121.sql)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='job_visit_snapshots' ORDER BY ordinal_position;
--
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='business_profit_targets' ORDER BY ordinal_position;
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid IN ('public.job_visit_snapshots'::regclass, 'public.business_profit_targets'::regclass);
--
-- SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
-- FROM pg_policy WHERE polrelid IN ('public.job_visit_snapshots'::regclass, 'public.business_profit_targets'::regclass);
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'job_visit_snapshots';
--
-- SELECT schemaname, tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename IN ('job_visit_snapshots', 'business_profit_targets');
-- (expected: zero rows -- neither table was added to realtime, see comment above)
