-- v11.0.6 — Audit log foundation, part 2 of 4: triggers.
--
-- Generic SECURITY DEFINER trigger function attached AFTER INSERT
-- OR UPDATE OR DELETE on the eight tenant-scoped tables we want a
-- can't-miss audit trail for. Captures:
--   - business_id (from row, NEW preferred / OLD for hard DELETE)
--   - user_id      (auth.uid() resolved through users.auth_user_id)
--   - action_type  (see logic below — derived from TG_OP + soft-delete
--                   + specific column transitions for jobs)
--   - entity_type  (from TG_TABLE_NAME, mapped to singular)
--   - entity_id    (from row id)
--   - old_values / new_values  (full row snapshots as jsonb)
--
-- Action-type derivation:
--   INSERT                                          → 'created'
--   UPDATE, deleted_at NULL→not-NULL                → 'deleted' (soft)
--   UPDATE, deleted_at not-NULL→NULL                → 'restored'
--   UPDATE, jobs.actual_start_at NULL→not-NULL      → 'started'
--   UPDATE, jobs.actual_end_at NULL→not-NULL        → 'ended'
--   UPDATE, jobs.cancelled false→true               → 'cancelled'
--   UPDATE, jobs.cancelled true→false               → 'restored'
--   UPDATE, no meaningful diff (only updated_at)    → SKIP (no insert)
--   UPDATE, otherwise                               → 'updated'
--   DELETE (hard)                                   → 'deleted'
--
-- Noise filter: when the only column that changed is updated_at,
-- skip writing an event. Otherwise every realtime tick or
-- mirror-write would create an audit row.
--
-- Cutover: triggers attach at the timestamp this migration runs
-- (recorded in supabase migration history). Events older than that
-- aren't captured (intentional — start clean per design decision).

-- ─── Trigger function ──────────────────────────────────────────
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
  -- Map table name → singular entity_type for the audit row.
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'jobs'                  THEN 'job'
    WHEN 'clients'               THEN 'client'
    WHEN 'employees'             THEN 'employee'
    WHEN 'payments'              THEN 'payment'
    WHEN 'job_applications'      THEN 'application'
    WHEN 'time_entries'          THEN 'time_entry'
    WHEN 'lunch_breaks'          THEN 'lunch_break'
    WHEN 'daily_assignments'     THEN 'daily_assignment'
    ELSE TG_TABLE_NAME
  END;

  -- Resolve business_id and entity_id from the row.
  IF TG_OP = 'DELETE' THEN
    v_business_id := (row_to_json(OLD)::jsonb)->>'business_id';
    v_entity_id   := (row_to_json(OLD)::jsonb)->>'id';
    v_old := to_jsonb(OLD);
    v_new := NULL;
  ELSE
    v_business_id := (row_to_json(NEW)::jsonb)->>'business_id';
    v_entity_id   := (row_to_json(NEW)::jsonb)->>'id';
    v_new := to_jsonb(NEW);
    IF TG_OP = 'UPDATE' THEN
      v_old := to_jsonb(OLD);
    END IF;
  END IF;

  -- Resolve the actor. auth.uid() returns NULL for service_role or
  -- trigger-from-trigger writes; that's the system-actor signal.
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;

  -- Action-type derivation.
  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSE
    -- UPDATE branch. Check specific column transitions in priority
    -- order; first match wins.
    IF (v_old->>'deleted_at') IS NULL AND (v_new->>'deleted_at') IS NOT NULL THEN
      v_action := 'deleted';
    ELSIF (v_old->>'deleted_at') IS NOT NULL AND (v_new->>'deleted_at') IS NULL THEN
      v_action := 'restored';
    ELSIF TG_TABLE_NAME = 'jobs' AND
          (v_old->>'cancelled')::boolean IS DISTINCT FROM (v_new->>'cancelled')::boolean
    THEN
      v_action := CASE WHEN (v_new->>'cancelled')::boolean THEN 'cancelled' ELSE 'restored' END;
    ELSIF TG_TABLE_NAME = 'jobs' AND
          (v_old->>'actual_start_at') IS NULL AND (v_new->>'actual_start_at') IS NOT NULL
    THEN
      v_action := 'started';
    ELSIF TG_TABLE_NAME = 'jobs' AND
          (v_old->>'actual_end_at') IS NULL AND (v_new->>'actual_end_at') IS NOT NULL
    THEN
      v_action := 'ended';
    ELSE
      -- Noise filter: if the only differing keys are updated_at /
      -- versionish fields, skip the write entirely. This silences
      -- realtime ticks and mirror-induced no-op updates.
      v_old_no_ts := v_old - 'updated_at';
      v_new_no_ts := v_new - 'updated_at';
      IF v_old_no_ts = v_new_no_ts THEN
        RETURN NULL; -- BEFORE/AFTER both fine — RETURN NULL is ignored on AFTER
      END IF;
      v_action := 'updated';
    END IF;
  END IF;

  -- Guard against missing business_id (shouldn't happen on our 8
  -- target tables, but defensive).
  IF v_business_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.audit_log (
    business_id, user_id, action_type, entity_type, entity_id,
    old_values, new_values, created_at
  ) VALUES (
    v_business_id, v_user_id, v_action, v_entity_type, v_entity_id,
    v_old, v_new, now()
  );

  RETURN NULL;  -- AFTER trigger: return value ignored
END;
$$;

REVOKE ALL ON FUNCTION public.audit_log_capture() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_log_capture() TO authenticated, service_role;

-- ─── Attach triggers to the 8 target tables ───────────────────
-- Drop+create so the migration is idempotent.

DROP TRIGGER IF EXISTS audit_jobs_capture                ON public.jobs;
DROP TRIGGER IF EXISTS audit_clients_capture             ON public.clients;
DROP TRIGGER IF EXISTS audit_employees_capture           ON public.employees;
DROP TRIGGER IF EXISTS audit_payments_capture            ON public.payments;
DROP TRIGGER IF EXISTS audit_applications_capture        ON public.job_applications;
DROP TRIGGER IF EXISTS audit_time_entries_capture        ON public.time_entries;
DROP TRIGGER IF EXISTS audit_lunch_breaks_capture        ON public.lunch_breaks;
DROP TRIGGER IF EXISTS audit_daily_assignments_capture   ON public.daily_assignments;

CREATE TRIGGER audit_jobs_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_clients_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_employees_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_payments_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_applications_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.job_applications
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_time_entries_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_lunch_breaks_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.lunch_breaks
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();

CREATE TRIGGER audit_daily_assignments_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.daily_assignments
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();
