-- PR #94 — Audit log CAPTURE sweep.
--
-- Tom asked for a full sweep of every write path in the app to confirm
-- audit_log capture is complete. All 10 tables he named explicitly
-- (clients, jobs, employees, teams, daily_assignments, payments,
-- chat_messages, incidents, job_issues, client_requests) already had
-- triggers -- no gap there. Sweeping the other 100+ business_id-scoped
-- tables for ones with REAL, currently-exercised write paths in
-- index.html (not dead schema -- most of the 100+ have 0 rows and no
-- app-side .insert()/.update() call site at all) turned up 6 gaps:
--
--   users                  -- role/permission changes, settings, soft-
--                             delete-on-departure. Security-relevant.
--   team_device_assignments -- GPS vehicle assignment (PR #89's save path).
--   employee_invites        -- who invited whom, revocations.
--   reward_ledger            \
--   reward_submissions        }  employee rewards system -- real
--   reward_redemptions       /   points/approval/fulfillment actions.
--
-- (client_keys and client_cancellations were also checked and are NOT
-- gaps: client_keys has zero write call sites anywhere in index.html
-- -- read-only from the app today -- and client_cancellations is a
-- historical import-populated table with no user_id/actor column at
-- all, not a live app write path. Both noted in the PR report, neither
-- gets a trigger here since there's nothing to capture yet.)
--
-- All 6 additions reuse the EXISTING action_type vocabulary (no CHECK
-- constraint change needed there) -- 'created'/'updated'/'deleted'/
-- 'restored' cover generic CRUD + the generic deleted_at soft-delete
-- branches already handle users/reward_submissions/reward_redemptions
-- (all three have a deleted_at column). Two tables get one additional
-- semantic branch each, mirroring the existing 'forms' status-approval
-- pattern:
--   reward_submissions.status -> 'approved'/'rejected'
--   reward_redemptions.status -> 'approved'/'rejected'/'fulfilled'
--     ('fulfilled' maps to the existing 'resolved' action_type --
--     same pending-to-done semantics as job_issue/incident resolution,
--     confirmed against the literal status strings the app writes at
--     index.html:9239/9263/9361/9387.)
--
-- entity_type DOES need new values: 'user', 'team_device_assignment',
-- 'reward_ledger', 'reward_submission', 'reward_redemption',
-- 'employee_invite'.

ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_entity_type_chk;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_entity_type_chk CHECK (entity_type = ANY (ARRAY[
  'job'::text, 'client'::text, 'employee'::text, 'payment'::text, 'application'::text,
  'time_entry'::text, 'lunch_break'::text, 'daily_assignment'::text, 'client_key'::text,
  'office'::text, 'team'::text, 'system'::text, 'job_issue'::text, 'incident'::text,
  'client_request'::text, 'chat_message'::text, 'form_submission'::text,
  'user'::text, 'team_device_assignment'::text, 'reward_ledger'::text,
  'reward_submission'::text, 'reward_redemption'::text, 'employee_invite'::text
]));

CREATE OR REPLACE FUNCTION public.audit_log_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    WHEN 'chat_messages'         THEN 'chat_message'
    WHEN 'forms'                 THEN 'form_submission'
    WHEN 'teams'                 THEN 'team'
    -- PR #94 additions.
    WHEN 'users'                  THEN 'user'
    WHEN 'team_device_assignments' THEN 'team_device_assignment'
    WHEN 'reward_ledger'          THEN 'reward_ledger'
    WHEN 'reward_submissions'     THEN 'reward_submission'
    WHEN 'reward_redemptions'     THEN 'reward_redemption'
    WHEN 'employee_invites'       THEN 'employee_invite'
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
    ELSIF TG_TABLE_NAME = 'forms' THEN
      v_action := 'submitted';
    ELSE
      v_action := 'created';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSE
    IF TG_TABLE_NAME = 'chat_messages' THEN
      v_old_no_ts := (v_old - 'read_at_admin' - 'read_at_emp');
      v_new_no_ts := (v_new - 'read_at_admin' - 'read_at_emp');
      IF v_old_no_ts = v_new_no_ts THEN RETURN NULL; END IF;
    END IF;

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
    ELSIF TG_TABLE_NAME = 'client_requests' AND
          (v_old->>'acknowledged_at') IS NULL AND (v_new->>'acknowledged_at') IS NOT NULL
    THEN
      v_action := 'acknowledged';
    ELSIF TG_TABLE_NAME = 'forms' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') = 'approved'
    THEN
      v_action := 'approved';
    ELSIF TG_TABLE_NAME = 'forms' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') IN ('denied','rejected')
    THEN
      v_action := 'rejected';
    ELSIF TG_TABLE_NAME = 'clients' AND
          (v_old->>'cancelled_at') IS NULL AND (v_new->>'cancelled_at') IS NOT NULL
    THEN
      v_action := 'cancelled';
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
    -- PR #94 additions -- reward approve/reject/fulfill, mirrors the
    -- 'forms' status-transition pattern immediately above. Status
    -- strings confirmed against the literal values index.html writes
    -- (PentaRewards.approveSubmission/rejectSubmission/fulfillRedemption).
    ELSIF TG_TABLE_NAME = 'reward_submissions' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') = 'approved'
    THEN
      v_action := 'approved';
    ELSIF TG_TABLE_NAME = 'reward_submissions' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') IN ('denied','rejected')
    THEN
      v_action := 'rejected';
    ELSIF TG_TABLE_NAME = 'reward_redemptions' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') = 'approved'
    THEN
      v_action := 'approved';
    ELSIF TG_TABLE_NAME = 'reward_redemptions' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') IN ('denied','rejected')
    THEN
      v_action := 'rejected';
    ELSIF TG_TABLE_NAME = 'reward_redemptions' AND
          (v_old->>'status') IS DISTINCT FROM (v_new->>'status') AND
          (v_new->>'status') = 'fulfilled'
    THEN
      v_action := 'resolved';
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
$function$;

-- ─── New triggers (mirror the exact existing per-table pattern) ────
CREATE TRIGGER audit_users_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_team_device_assignments_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.team_device_assignments
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_employee_invites_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_invites
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_reward_ledger_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.reward_ledger
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_reward_submissions_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.reward_submissions
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_reward_redemptions_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();
