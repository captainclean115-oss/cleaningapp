-- v11.0.17 — Extend audit_log for client_requests.
--
-- Three pieces:
--   1. Add 'acknowledged' to action_type CHECK
--   2. Add 'client_request' to entity_type CHECK
--   3. Extend audit_log_capture() to detect acknowledged_at NULL→NOT
--      NULL transition (mirrors job_issues.resolved_at handling)
--   4. Attach trigger to public.client_requests

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_type_chk;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_action_type_chk CHECK (action_type IN (
    'created','updated','deleted','restored',
    'moved','cancelled','started','ended',
    'submitted','approved','rejected',
    'manual_note','manual_override',
    'received','refunded','resolved',
    'acknowledged'
  ));

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_entity_type_chk;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN (
    'job','client','employee','payment',
    'application','time_entry','lunch_break',
    'daily_assignment','client_key','office',
    'team','system','job_issue','incident',
    'client_request'
  ));

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
    WHEN 'incidents'             THEN 'incident'
    WHEN 'client_requests'       THEN 'client_request'
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
    IF TG_TABLE_NAME = 'payments' THEN
      v_action := 'received';
    ELSE
      v_action := 'created';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSE
    IF (v_old->>'deleted_at') IS NULL AND (v_new->>'deleted_at') IS NOT NULL THEN
      v_action := 'deleted';
    ELSIF (v_old->>'deleted_at') IS NOT NULL AND (v_new->>'deleted_at') IS NULL THEN
      v_action := 'restored';
    ELSIF TG_TABLE_NAME = 'job_issues' AND
          (v_old->>'resolved_at') IS NULL AND (v_new->>'resolved_at') IS NOT NULL
    THEN
      v_action := 'resolved';
    ELSIF TG_TABLE_NAME = 'incidents' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') = 'resolved'
    THEN
      v_action := 'resolved';
    ELSIF TG_TABLE_NAME = 'payments' AND
          COALESCE((v_old->>'voided')::boolean, false) = false AND
          COALESCE((v_new->>'voided')::boolean, false) = true
    THEN
      v_action := 'refunded';
    -- v11.0.17: client_requests acknowledged_at NULL→NOT NULL → 'acknowledged'.
    ELSIF TG_TABLE_NAME = 'client_requests' AND
          (v_old->>'acknowledged_at') IS NULL AND (v_new->>'acknowledged_at') IS NOT NULL
    THEN
      v_action := 'acknowledged';
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
      IF v_old_no_ts = v_new_no_ts THEN RETURN NULL; END IF;
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

DROP TRIGGER IF EXISTS audit_client_requests_capture ON public.client_requests;
CREATE TRIGGER audit_client_requests_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.client_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();
