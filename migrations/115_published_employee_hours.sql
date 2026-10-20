-- Published Hours (PR #198 follow-up, "Published Hours" feature).
--
-- The employee portal's Hours screen (even after the portal-hours-match-
-- manager fix on this branch) computes live via loadWeekHours(), which
-- pulls the WHOLE business's manual_hour_overrides and daily_assignments,
-- plus a full-fleet Geotab Device/Trip fetch, into the calling employee's
-- own browser -- confirmed during PR #198 review that this hands every
-- employee's override data and every team's GPS/vehicle trips to any one
-- employee's phone (narrowed only by what gets RENDERED, not by what
-- gets FETCHED). This table removes the need for the portal to compute
-- anything at all: a manager-reviewed, pre-resolved copy of each
-- employee's own finished days, written by the SAME resolveEmployeeDayHours
-- function the manager's own Hours table already uses (see index.html),
-- never a second calculation. The portal reads only this table, filtered
-- by RLS to the logged-in employee's own employee_id -- no Geotab call,
-- no whole-business override/assignment fetch, ever, from a field
-- employee's own device.
--
-- Renumbered from 114 to 115 before first apply: PR #196's branch
-- (salaried-admin-salary-amount) independently claimed 114 for
-- migrations/114_employee_salary_amount.sql (different file, no shared
-- table/column, no real collision -- just confusing numbering). This
-- file is otherwise unchanged in intent from the original 114 draft.
--
-- One row per (business, employee, work_date). NEVER contains addresses,
-- coordinates, vehicle/device info, other employees' data, pay rate, or
-- salary amount -- only what an employee is allowed to see about her own
-- single day.
CREATE TABLE IF NOT EXISTS public.published_employee_hours (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT (not CASCADE): a hard delete of an employee who
  -- has published pay history must fail loudly instead of silently
  -- erasing it. See the "HARD DELETE" section at the bottom of this
  -- file for the full reasoning and the two sibling tables (migrations
  -- 032, 110) that still use CASCADE and why this one deliberately
  -- doesn't match them.
  employee_id    uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  work_date      date NOT NULL,
  hours          numeric,
  -- timestamptz, not a bare time-of-day: a real shift in this app can
  -- start before and end after UTC midnight (the equivalence test suite
  -- added in PR #198 specifically covers this). resolveEmployeeDayHours
  -- already returns real Date instants (startDate/endDate) for exactly
  -- this reason -- storing anything less loses the information needed
  -- to render the shift correctly across a UTC day boundary.
  start_time     timestamptz,
  end_time       timestamptz,
  lunch_minutes  integer,
  -- Field employees only ("B1", "S3", ...). Always NULL for Admin/Office
  -- (hourly or salaried) -- no team/vehicle language for them, per spec.
  team_label     text,
  status         text NOT NULL CHECK (status IN ('worked','off','vacation','salaried','not_published')),
  -- Only meaningful when status='worked'. NULL for off/vacation/salaried
  -- days (there is no "source of hours" when there are no hours).
  source         text CHECK (source IS NULL OR source IN ('gps','override','manual')),
  published_at   timestamptz NOT NULL DEFAULT now(),
  -- ON DELETE SET NULL (not the bare default NO ACTION the original
  -- draft left this as): a manager's own account being hard-deleted
  -- someday must not block or cascade-delete every row she ever
  -- published -- "who published this" losing its value is harmless;
  -- "this payroll history disappeared because a former manager's
  -- account was removed" would not be.
  published_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE (business_id, employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_published_employee_hours_business_employee_date
  ON public.published_employee_hours (business_id, employee_id, work_date);

ALTER TABLE public.published_employee_hours ENABLE ROW LEVEL SECURITY;

-- DROP POLICY IF EXISTS before each CREATE POLICY: Postgres has no
-- `CREATE POLICY IF NOT EXISTS` (confirmed against this project's own
-- Postgres 17.6), so without this the file would fail on a second run
-- the moment it reached the first CREATE POLICY, even though the
-- CREATE TABLE/INDEX lines above it are already safely re-runnable.

-- SELECT: an employee sees ONLY her own published rows. Managers see
-- every row in their business. Same auth_belongs_to_business + per-row
-- auth_user_id-match pattern as time_entries_select (migration 032) --
-- the one table in this app whose RLS was already confirmed correct for
-- this exact "employee self, manager all" shape, and re-confirmed this
-- round against real data (Blanca Payan, an active linked employee):
-- her own auth_user_id matches both her employees row and her users
-- row's business_id, so both branches of this policy resolve correctly
-- for her specifically, not just in the abstract.
DROP POLICY IF EXISTS published_employee_hours_select ON public.published_employee_hours;
CREATE POLICY published_employee_hours_select ON public.published_employee_hours FOR SELECT
USING (
  auth_belongs_to_business(business_id) AND (
    EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = published_employee_hours.employee_id AND e.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
    )
  )
);

-- INSERT/UPDATE/DELETE: managers only. No policy at all matches an
-- employee's own auth_user_id for any write -- RLS denies by default,
-- she can never publish her own hours. (Deliberately NOT a single
-- `FOR ALL` policy -- see project memory feedback_rls_for_all_leaks_select:
-- a FOR ALL policy covers SELECT too, which would undo the per-employee
-- SELECT restriction above. Four separate policies, like manual_hour_
-- overrides migration 110, keeps the read gate the only read path.)
DROP POLICY IF EXISTS published_employee_hours_insert ON public.published_employee_hours;
CREATE POLICY published_employee_hours_insert ON public.published_employee_hours FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin','manager','dispatcher')
  )
);

DROP POLICY IF EXISTS published_employee_hours_update ON public.published_employee_hours;
CREATE POLICY published_employee_hours_update ON public.published_employee_hours FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin','manager','dispatcher')
  )
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin','manager','dispatcher')
  )
);

DROP POLICY IF EXISTS published_employee_hours_delete ON public.published_employee_hours;
CREATE POLICY published_employee_hours_delete ON public.published_employee_hours FOR DELETE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin','manager','dispatcher')
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.published_employee_hours TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- REALTIME -- so the portal's live-update subscription actually fires.
-- Confirmed by querying pg_publication_tables directly: this project has
-- an existing precedent for forgetting this step (migration 112, `users`
-- for the Claire voice-toggle feature, is STILL not applied for the same
-- reason) -- folded into this same file instead of a separate one so it
-- can't be split off and forgotten the same way.
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'published_employee_hours'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.published_employee_hours';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (not applied -- run this block to undo everything above)
-- ═══════════════════════════════════════════════════════════════════════
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.published_employee_hours;
-- DROP POLICY IF EXISTS published_employee_hours_select ON public.published_employee_hours;
-- DROP POLICY IF EXISTS published_employee_hours_insert ON public.published_employee_hours;
-- DROP POLICY IF EXISTS published_employee_hours_update ON public.published_employee_hours;
-- DROP POLICY IF EXISTS published_employee_hours_delete ON public.published_employee_hours;
-- DROP INDEX IF EXISTS public.idx_published_employee_hours_business_employee_date;
-- DROP TABLE IF EXISTS public.published_employee_hours;

-- ═══════════════════════════════════════════════════════════════════════
-- HARD DELETE -- what happens to published rows when an employee is
-- hard-deleted (delete_employee_with_auth, migrations 108/109).
-- ═══════════════════════════════════════════════════════════════════════
-- employee_id above is ON DELETE RESTRICT (option B from the original
-- draft's three-option proposal), not CASCADE like its sibling tables
-- (manual_hour_overrides migration 110, time_entries migration 032).
-- Effect: delete_employee_with_auth's `DELETE FROM public.employees`
-- will fail outright with a foreign-key-violation error for any employee
-- who has even one published_employee_hours row, instead of silently
-- deleting her pay history along with her. This is a deliberate
-- divergence from the sibling tables' convention -- published hours are
-- the manager-reviewed, employee-facing record of what she was actually
-- paid for, which is a materially different kind of data than a raw GPS/
-- clock entry or an in-progress correction.
--
-- This also closes a real gap found while reviewing the existing
-- hard-delete safety check: the client-side history gate
-- (_deleteEmployeeHistoryCounts, confirmed live on main via PR #197's
-- own merge commit) counts daily_assignments/time_entries/manual_hour_
-- overrides/lunch_breaks/reward_ledger/reward_redemptions/reward_
-- submissions/forms, but did NOT know about published_employee_hours --
-- see the separate index.html change in this same patch that adds it to
-- that list. With BOTH the UI gate and this FK in place, an employee
-- with published hours can't be hard-deleted either by accident (the UI
-- warns and disables the button) or by a direct RPC call that bypasses
-- the UI entirely (the FK still blocks it).
--
-- If RESTRICT ever proves too strict in practice (a manager needs to
-- hard-delete someone with real published history, e.g. a true data-
-- entry mistake), the remaining alternative from the original proposal
-- is option C: make employee_id nullable, ON DELETE SET NULL, add an
-- employee_name_snapshot text column written at publish time, and add a
-- second SELECT policy branch for the now-unlinkable historical rows.
-- Not applied -- would need its own migration and a portal code change.

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run these after applying, to confirm)
-- ═══════════════════════════════════════════════════════════════════════
-- Table exists with the right columns:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='published_employee_hours'
-- ORDER BY ordinal_position;

-- All 4 policies exist:
-- SELECT polname, polcmd FROM pg_policy
-- WHERE polrelid = 'public.published_employee_hours'::regclass;

-- Grants are authenticated-only (no anon row should appear):
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_name = 'published_employee_hours';

-- Realtime publication membership:
-- SELECT schemaname, tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'published_employee_hours';

-- FK is RESTRICT, not CASCADE (confirms the hard-delete behavior above):
-- SELECT confdeltype FROM pg_constraint
-- WHERE conrelid = 'public.published_employee_hours'::regclass
-- AND conname = 'published_employee_hours_employee_id_fkey';
-- -- 'r' = RESTRICT (expected), 'c' = CASCADE (would mean this didn't apply correctly)
