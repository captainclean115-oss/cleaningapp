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
-- One row per (business, employee, work_date). NEVER contains addresses,
-- coordinates, vehicle/device info, other employees' data, pay rate, or
-- salary amount -- only what an employee is allowed to see about her own
-- single day.
CREATE TABLE IF NOT EXISTS public.published_employee_hours (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
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
  published_by   uuid REFERENCES public.users(id),
  UNIQUE (business_id, employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_published_employee_hours_business_employee_date
  ON public.published_employee_hours (business_id, employee_id, work_date);

ALTER TABLE public.published_employee_hours ENABLE ROW LEVEL SECURITY;

-- SELECT: an employee sees ONLY her own published rows. Managers see
-- every row in their business. Same auth_belongs_to_business + per-row
-- auth_user_id-match pattern as time_entries_select (migration 032) --
-- the one table in this app whose RLS was already confirmed correct for
-- this exact "employee self, manager all" shape.
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
CREATE POLICY published_employee_hours_insert ON public.published_employee_hours FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin','manager','dispatcher')
  )
);

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
-- ROLLBACK (not applied -- run this block to undo the above)
-- ═══════════════════════════════════════════════════════════════════════
-- DROP POLICY IF EXISTS published_employee_hours_select ON public.published_employee_hours;
-- DROP POLICY IF EXISTS published_employee_hours_insert ON public.published_employee_hours;
-- DROP POLICY IF EXISTS published_employee_hours_update ON public.published_employee_hours;
-- DROP POLICY IF EXISTS published_employee_hours_delete ON public.published_employee_hours;
-- DROP INDEX IF EXISTS public.idx_published_employee_hours_business_employee_date;
-- DROP TABLE IF EXISTS public.published_employee_hours;

-- ═══════════════════════════════════════════════════════════════════════
-- HARD-DELETE FK PROPOSAL -- NOT PART OF THIS MIGRATION, NOT APPLIED.
-- ═══════════════════════════════════════════════════════════════════════
-- As written above, employee_id has ON DELETE CASCADE, matching the
-- existing convention for manual_hour_overrides (migration 110) and
-- time_entries (migration 032): hard-deleting an employee (the
-- delete_employee_with_auth flow, migrations 108/109) silently deletes
-- every published_employee_hours row for her too -- including finished,
-- manager-reviewed pay history for weeks she actually worked.
--
-- That is a real tension with "do not delete published rows when someone
-- is ... deleted by hand" -- CASCADE does exactly that. Three options,
-- not applied, for Tom to choose:
--
--   (A) Leave CASCADE as-is (current default above). Simplest, consistent
--       with every sibling table, but a hard delete erases pay history.
--
--   (B) Block the hard delete instead of silently losing history:
--         ALTER TABLE public.published_employee_hours
--           DROP CONSTRAINT published_employee_hours_employee_id_fkey,
--           ADD CONSTRAINT published_employee_hours_employee_id_fkey
--             FOREIGN KEY (employee_id) REFERENCES public.employees(id)
--             ON DELETE RESTRICT;
--       delete_employee_with_auth would then fail with a plain FK error
--       for anyone who has published hours, until those rows are handled
--       on purpose (archived elsewhere, or a manager explicitly deletes
--       them first).
--
--   (C) Keep history readable after a hard delete, detached from the
--       employee row: make employee_id nullable, SET NULL on delete, and
--       snapshot the name at publish time so old rows stay meaningful:
--         ALTER TABLE public.published_employee_hours
--           ALTER COLUMN employee_id DROP NOT NULL,
--           DROP CONSTRAINT published_employee_hours_employee_id_fkey,
--           ADD CONSTRAINT published_employee_hours_employee_id_fkey
--             FOREIGN KEY (employee_id) REFERENCES public.employees(id)
--             ON DELETE SET NULL,
--           ADD COLUMN employee_name_snapshot text;
--       (publish code would need to start writing employee_name_snapshot
--       on every upsert; the SELECT RLS policy above would also need a
--       second branch, since employee_id IS NULL can no longer match
--       e.auth_user_id -- straightforward, but a real code change, not
--       applied here.)
--
-- Recommendation: (B). It costs nothing until a hard delete is actually
-- attempted, and it forces a deliberate decision at that moment instead
-- of silently losing payroll history -- which matches how CASCADE on
-- manual_hour_overrides/time_entries has never actually been exercised
-- in production (hard delete is a rare, manager-initiated action, not a
-- routine one).
