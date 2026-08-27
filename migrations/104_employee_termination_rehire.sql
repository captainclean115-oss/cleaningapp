-- PR #149 — employee termination/rehire flow with proper cleanup.
--
-- CRITICAL PRE-EXISTING FINDING (not introduced by this migration, but a
-- required prerequisite fix): employees.status already includes
-- 'terminated' (CHECK constraint), and employees.terminated_at (date)
-- already exists -- 50 employees are already status='terminated' in
-- production today, via TWO existing, uncoordinated paths:
--   1. Setting the Status dropdown to "Terminated" and saving -- writes
--      status='terminated' only, no terminated_at, no deleted_at. These
--      employees remain visible in PentaEmployees' cache today.
--   2. The "Delete"/"Remove" employee button -- calls PentaEmployees
--      .archive(id), which sets status='terminated' AND terminated_at
--      AND deleted_at all at once. Because PentaEmployees._hydrate()
--      filters .is('deleted_at', null), every employee terminated this
--      way is COMPLETELY INVISIBLE to the facade cache -- not just
--      excluded from the active roster, but absent from every "Archived"
--      UI section too, and from any historical hours/team lookup.
--      40 of the 50 currently-terminated employees are in this state.
--
-- This migration does NOT retroactively clear deleted_at for those 40
-- rows -- that would silently change the visibility of 40 real employee
-- records, and there's no reliable way to distinguish "this was really
-- just a termination that happened to go through the Delete button" from
-- "this manager genuinely wanted this row gone" after the fact. Flagged
-- for Tom to decide as an explicit follow-up, not auto-fixed here.
--
-- Going forward, this PR's terminateEmployee() (index.html) never sets
-- deleted_at -- termination and deletion are now distinct concepts.
-- deleted_at continues to mean "this row itself was a mistake," while
-- status='terminated' + terminated_at means "this was a real employee
-- who no longer works here," which stays visible in the Archived section
-- and contributes correctly to historical hours/payroll for dates before
-- their termination.

-- ═══════════════════════════════════════════════════════════════
-- 1. New columns. termination_date is NOT added -- terminated_at
--    (date, already exists) already serves that exact purpose.
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.employees
  ADD COLUMN termination_reason text
    CHECK (termination_reason IN (
      'voluntary_resignation', 'termination_performance', 'termination_attendance',
      'termination_misconduct', 'layoff', 'retirement', 'job_abandonment', 'other'
    )),
  ADD COLUMN termination_notes text,
  ADD COLUMN terminated_by uuid REFERENCES public.users(id),
  ADD COLUMN eligible_for_rehire boolean DEFAULT true;

COMMENT ON COLUMN public.employees.termination_reason IS
  'Set only when status=''terminated''. If ''other'', termination_notes must be non-null (enforced application-side in terminateEmployee(), index.html -- not a DB CHECK, since that would need a cross-column constraint referencing termination_notes).';
COMMENT ON COLUMN public.employees.eligible_for_rehire IS
  'Nullable so "not yet decided" is distinguishable from an explicit true/false. NULL/true both bypass the rehire warning; false requires an explicit override confirmation in the UI. Not cleared on rehire (unlike the other termination_* fields) -- becomes moot until the next termination, per spec.';

-- ═══════════════════════════════════════════════════════════════
-- 2. audit_log: 'terminated'/'rehired' are clearer than overloading
--    'updated' for an HR event with reason/notes context. entity_type
--    'employee' already existed in the CHECK constraint -- no change
--    needed there.
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_action_type_chk;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_type_chk
  CHECK (action_type = ANY (ARRAY[
    'created', 'updated', 'deleted', 'restored', 'moved', 'cancelled', 'started', 'ended',
    'submitted', 'approved', 'rejected', 'manual_note', 'manual_override', 'received',
    'refunded', 'resolved', 'acknowledged', 'terminated', 'rehired'
  ]::text[]));

-- ═══════════════════════════════════════════════════════════════
-- 3. Schedule projection engine (migration 102) — skip a resolved team
--    when it has zero active employees left (e.g. every member was
--    terminated), falling through to the existing "last completed job's
--    team" rule, exactly as migration 102 already did for "no preferred
--    team set at all." Same function signature, so this CREATE OR
--    REPLACE correctly replaces the existing definition rather than
--    creating a second overload.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.project_recurring_jobs_for_business(
  p_business_id uuid,
  p_as_of date DEFAULT current_date,
  p_window_months integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_client         record;
  v_interval_days  integer;
  v_window_end     date;
  v_k_start        integer;
  v_date           date;
  v_half_interval  integer;
  v_team           text;
  v_clients_processed integer := 0;
  v_jobs_created       integer := 0;
  v_errors             jsonb := '[]'::jsonb;
BEGIN
  v_window_end := (p_as_of + (p_window_months || ' months')::interval)::date;

  FOR v_client IN
    SELECT c.id, c.external_id, c.anchor_date, c.frequency,
           c.preferred_team_id, c.current_price, c.estimated_minutes
    FROM public.clients c
    WHERE c.business_id = p_business_id
      AND c.status = 'active'
      AND c.frequency IS NOT NULL
      AND c.frequency <> 'OMS'
      AND c.anchor_date IS NOT NULL
  LOOP
    BEGIN
      v_clients_processed := v_clients_processed + 1;
      v_interval_days := public.recurring_interval_days(v_client.frequency::text);
      IF v_interval_days IS NULL THEN
        v_errors := v_errors || jsonb_build_object(
          'client_external_id', v_client.external_id,
          'error', 'unrecognized frequency: ' || v_client.frequency
        );
        CONTINUE;
      END IF;
      v_half_interval := v_interval_days / 2;

      v_k_start := GREATEST(0, CEIL((p_as_of - v_client.anchor_date)::numeric / v_interval_days));
      v_date := v_client.anchor_date + (v_k_start * v_interval_days);

      WHILE v_date <= v_window_end LOOP
        IF EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.business_id = p_business_id
            AND j.client_id = v_client.external_id
            AND j.date = v_date
        ) THEN
          NULL;
        ELSIF EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.business_id = p_business_id
            AND j.client_id = v_client.external_id
            AND j.date <> v_date
            AND j.date BETWEEN (v_date - v_half_interval) AND (v_date + v_half_interval)
        ) THEN
          NULL;
        ELSE
          -- PR #149: preferred team, but only if it still has ≥1 active
          -- employee -- a terminated-out roster is treated the same as
          -- "no preferred team," falling through to the completed-job
          -- fallback below.
          v_team := NULL;
          IF v_client.preferred_team_id IS NOT NULL THEN
            SELECT t.name INTO v_team
            FROM public.teams t
            WHERE t.id = v_client.preferred_team_id
              AND t.business_id = p_business_id
              AND EXISTS (
                SELECT 1 FROM public.employees e
                WHERE e.team_id = t.id AND e.business_id = p_business_id AND e.status = 'active'
              );
          END IF;
          IF v_team IS NULL THEN
            -- PR #149: same active-employee guard on the fallback team --
            -- if the client's historically-serviced team has also been
            -- fully terminated out, leave v_team NULL (admin assigns),
            -- matching the existing "no preferred team" null fallback.
            SELECT j.team INTO v_team
            FROM public.jobs j
            WHERE j.business_id = p_business_id
              AND j.client_id = v_client.external_id
              AND j.status = 'completed'
              AND j.team IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.employees e
                JOIN public.teams t2 ON t2.name = j.team AND t2.business_id = p_business_id
                WHERE e.team_id = t2.id AND e.business_id = p_business_id AND e.status = 'active'
              )
            ORDER BY j.date DESC
            LIMIT 1;
          END IF;

          INSERT INTO public.jobs (
            business_id, client_id, date, team, price, duration_minutes,
            status, auto_generated, projection_source
          ) VALUES (
            p_business_id, v_client.external_id, v_date, v_team,
            v_client.current_price, v_client.estimated_minutes,
            'scheduled', true, 'auto_projected'
          );
          v_jobs_created := v_jobs_created + 1;
        END IF;

        v_date := v_date + v_interval_days;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object(
        'client_external_id', v_client.external_id,
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'as_of', p_as_of,
    'window_end', v_window_end,
    'clients_processed', v_clients_processed,
    'jobs_created', v_jobs_created,
    'errors', v_errors
  );
END;
$$;
