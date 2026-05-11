-- Sprint 11.6 prep — employee time tracking + job-start/stop timestamps.
--
-- Three additions:
--   1. time_entries table — clock-in / clock-out per employee. Geo-tagged
--      so payroll can spot-check "did they clock in from the depot".
--   2. jobs.actual_start_at / actual_end_at — when a team leader marked the
--      job started/stopped on site. Two extra audit columns track who hit
--      the button. Per Tom's call: simple columns on jobs (not a separate
--      job_visits table) — we'll split out if multi-visit ever lands.
--   3. set_job_actual_time(job_id, mode) RPC — SECURITY DEFINER so a team
--      leader (role='employee' in users, is_team_leader=true on employees)
--      can write the timestamps without loosening jobs_update RLS to
--      employees globally. Validates business + TL flag, then writes.

-- =========================================================================
-- 1) time_entries — clock-in / clock-out shifts.
-- =========================================================================
CREATE TABLE public.time_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  clock_in_at     timestamptz NOT NULL DEFAULT now(),
  clock_out_at    timestamptz,
  clock_in_lat    numeric,
  clock_in_lng    numeric,
  clock_out_lat   numeric,
  clock_out_lng   numeric,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX idx_time_entries_emp_date
  ON public.time_entries (business_id, employee_id, clock_in_at DESC)
  WHERE deleted_at IS NULL;

-- Open shift lookup — "is this employee currently clocked in?". Partial index
-- on clock_out_at IS NULL is small even for huge time_entries volumes.
CREATE INDEX idx_time_entries_open_shifts
  ON public.time_entries (business_id, employee_id)
  WHERE clock_out_at IS NULL AND deleted_at IS NULL;

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

-- SELECT: employees see own shifts; managers see all in business.
CREATE POLICY time_entries_select ON public.time_entries FOR SELECT
USING (
  auth_belongs_to_business(business_id) AND (
    EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = time_entries.employee_id AND e.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
    )
  )
);

-- INSERT: employee can only insert their own clock-in.
CREATE POLICY time_entries_insert ON public.time_entries FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id) AND
  EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = time_entries.employee_id AND e.auth_user_id = auth.uid()
  )
);

-- UPDATE: employee can update own open shift (clock-out); managers can update any.
CREATE POLICY time_entries_update ON public.time_entries FOR UPDATE
USING (
  auth_belongs_to_business(business_id) AND (
    EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = time_entries.employee_id AND e.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
    )
  )
)
WITH CHECK (
  auth_belongs_to_business(business_id) AND (
    EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = time_entries.employee_id AND e.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
    )
  )
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_time_entries_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER time_entries_updated_at
  BEFORE UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_time_entries_updated_at();

GRANT SELECT, INSERT, UPDATE ON public.time_entries TO authenticated;

-- =========================================================================
-- 2) jobs.actual_start_at / actual_end_at — on-site time tracking.
-- =========================================================================
ALTER TABLE public.jobs
  ADD COLUMN actual_start_at timestamptz,
  ADD COLUMN actual_end_at   timestamptz,
  ADD COLUMN actual_start_by uuid REFERENCES public.employees(id),
  ADD COLUMN actual_end_by   uuid REFERENCES public.employees(id);

-- =========================================================================
-- 3) set_job_actual_time RPC — lets team leaders write the timestamps
--    without loosening jobs_update RLS to all employees.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.set_job_actual_time(
  p_job_id uuid,
  p_mode   text   -- 'start' or 'end'
)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp        public.employees%ROWTYPE;
  v_user_biz   uuid;
  v_job        public.jobs%ROWTYPE;
BEGIN
  -- Resolve caller's employees row + business.
  SELECT e.* INTO v_emp
  FROM public.employees e
  WHERE e.auth_user_id = auth.uid()
    AND e.deleted_at IS NULL
    AND e.terminated_at IS NULL
    AND e.status = 'active'
  LIMIT 1;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'No active employee row for current user';
  END IF;

  -- Manager+ short-circuit: full power. TLs (employee role + is_team_leader)
  -- can also write. Non-TL employees blocked.
  IF NOT v_emp.is_team_leader
     AND NOT EXISTS (
       SELECT 1 FROM public.users u
       WHERE u.id = auth.uid()
       AND u.role IN ('owner','admin','manager','dispatcher')
     )
  THEN
    RAISE EXCEPTION 'Only team leaders can start/stop jobs';
  END IF;

  -- Same-business check.
  SELECT u.business_id INTO v_user_biz FROM public.users u WHERE u.id = auth.uid();
  SELECT j.* INTO v_job FROM public.jobs j WHERE j.id = p_job_id;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Job not found';
  END IF;
  IF v_job.business_id <> v_user_biz THEN
    RAISE EXCEPTION 'Cross-business operation blocked';
  END IF;

  IF p_mode = 'start' THEN
    UPDATE public.jobs
      SET actual_start_at = now(),
          actual_start_by = v_emp.id
      WHERE id = p_job_id
      RETURNING * INTO v_job;
  ELSIF p_mode = 'end' THEN
    UPDATE public.jobs
      SET actual_end_at = now(),
          actual_end_by = v_emp.id
      WHERE id = p_job_id
      RETURNING * INTO v_job;
  ELSE
    RAISE EXCEPTION 'Invalid mode: %', p_mode;
  END IF;

  RETURN v_job;
END $$;

REVOKE ALL ON FUNCTION public.set_job_actual_time(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_job_actual_time(uuid, text) TO authenticated;
