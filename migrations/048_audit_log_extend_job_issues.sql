-- v11.0.9 — Extend audit_log to capture job_issues.
--
-- Three things:
--   1. Add 'resolved' to action_type CHECK constraint
--   2. Add 'job_issue' to entity_type CHECK constraint
--   3. Extend audit_log_capture() to detect resolved_at NULL→NOT NULL
--      on job_issues and tag the event as action_type='resolved'
--   4. Attach the trigger to public.job_issues
--
-- Mirrors the cancelled_at → 'cancelled' pattern already in the
-- trigger for jobs (mig 046).

-- ─── 1 + 2: extend CHECK constraints ──────────────────────────────
ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_type_chk;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_action_type_chk CHECK (action_type IN (
    'created','updated','deleted','restored',
    'moved','cancelled','started','ended',
    'submitted','approved','rejected',
    'manual_note','manual_override',
    'received','refunded',
    'resolved'
  ));

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_entity_type_chk;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN (
    'job','client','employee','payment',
    'application','time_entry','lunch_break',
    'daily_assignment','client_key','office',
    'team','system',
    'job_issue'
  ));

-- ─── 3: extend trigger function ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_log_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id  uuid;
  v_user_id      uuid;
  v_action       text;
  v_entity_type  text;
  v_entity_id    uuid;
  v_old          jsonb;
  v_new          jsonb;
  v_old_no_ts    jsonb;
  v_new_no_ts    jsonb;
BEGIN
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'jobs'                  THEN 'job'
    WHEN 'clients'               THEN 'client'
    WHEN 'employees'             THEN 'employee'
    WHEN 'payments'              THEN 'payment'
    WHEN 'job_applications'      THEN 'application'
    WHEN 'time_entries'          THEN 'time_entry'
    WHEN 'lunch_breaks'          THEN 'lunch_break'
    WHEN 'daily_assignments'     THEN 'daily_assignment'
    WHEN 'job_issues'            THEN 'job_issue'
    ELSE TG_TABLE_NAME
  END;

  IF TG_OP = 'DELETE' THEN
    v_business_id := (row_to_json(OLD)::jsonb)->>'business_id';
    v_entity_id   := (row_to_json(OLD)::jsonb)->>'id';
    v_old := to_jsonb(OLD);
    v_new := NULL;
  ELSE
    v_business_id := (row_to_json(NEW)::jsonb)->>'business_id';
    v_entity_id   := (row_to_json(NEW)::jsonb)->>'id';
    v_new := to_jsonb(NEW);
    IF TG_OP = 'UPDATE' THEN v_old := to_jsonb(OLD); END IF;
  END IF;

  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;

  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSE
    -- UPDATE branch.
    IF (v_old->>'deleted_at') IS NULL AND (v_new->>'deleted_at') IS NOT NULL THEN
      v_action := 'deleted';
    ELSIF (v_old->>'deleted_at') IS NOT NULL AND (v_new->>'deleted_at') IS NULL THEN
      v_action := 'restored';
    -- v11.0.9: job_issues resolved_at NULL→NOT NULL transition.
    ELSIF TG_TABLE_NAME = 'job_issues' AND
          (v_old->>'resolved_at') IS NULL AND (v_new->>'resolved_at') IS NOT NULL
    THEN
      v_action := 'resolved';
    ELSIF TG_TABLE_NAME = 'jobs' AND
          (v_old->>'cancelled_at') IS NULL AND (v_new->>'cancelled_at') IS NOT NULL
    THEN
      v_action := 'cancelled';
    ELSIF TG_TABLE_NAME = 'jobs' AND
          (v_old->>'cancelled_at') IS NOT NULL AND (v_new->>'cancelled_at') IS NULL
    THEN
      v_action := 'restored';
    ELSIF TG_TABLE_NAME = 'jobs' AND
          (v_old->>'actual_start_at') IS NULL AND (v_new->>'actual_start_at') IS NOT NULL
    THEN
      v_action := 'started';
    ELSIF TG_TABLE_NAME = 'jobs' AND
          (v_old->>'actual_end_at') IS NULL AND (v_new->>'actual_end_at') IS NOT NULL
    THEN
      v_action := 'ended';
    ELSE
      v_old_no_ts := v_old - 'updated_at';
      v_new_no_ts := v_new - 'updated_at';
      IF v_old_no_ts = v_new_no_ts THEN
        RETURN NULL;
      END IF;
      v_action := 'updated';
    END IF;
  END IF;

  IF v_business_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.audit_log (
    business_id, user_id, action_type, entity_type, entity_id,
    old_values, new_values, created_at
  ) VALUES (
    v_business_id, v_user_id, v_action, v_entity_type, v_entity_id,
    v_old, v_new, now()
  );

  RETURN NULL;
END;
$$;

-- ─── 4: attach trigger to job_issues ──────────────────────────────
DROP TRIGGER IF EXISTS audit_job_issues_capture ON public.job_issues;
CREATE TRIGGER audit_job_issues_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.job_issues
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();
