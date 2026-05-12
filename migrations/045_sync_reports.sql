-- v11.0.6 — Maids Sync Report Phase 1.
--
-- Two pieces:
--   1. sync_reports table — per-(tenant, date) state row tracking
--      when the report was generated, viewed, and marked synced.
--      One row per business per date. RLS gated to manager-tier.
--   2. get_daily_sync_data(business_id, date) RPC — aggregates
--      audit_log for the date into the diff shape the UI consumes.
--
-- Phase 1 categories: new_clients, schedule_changes, time_entries,
-- client_deletions, applications. Each surfaces as a section with
-- counts + a list of human-readable rows.
--
-- Future-proofing for the eventual browser-extension that replaces
-- the manual data-entry step: the RPC returns structured JSON. The
-- extension can consume the same shape and post-back marked_synced_at
-- without UI changes. The UI is just one consumer of the RPC.

CREATE TABLE public.sync_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  report_date       date NOT NULL,
  generated_at      timestamptz NOT NULL DEFAULT now(),
  viewed_at         timestamptz,
  viewed_by_user_id uuid REFERENCES public.users(id),
  marked_synced_at  timestamptz,
  marked_synced_by  uuid REFERENCES public.users(id),
  notes             text,
  items_count       integer DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sync_reports_business_date_uq
  ON public.sync_reports (business_id, report_date);

CREATE INDEX sync_reports_business_idx
  ON public.sync_reports (business_id, report_date DESC);

ALTER TABLE public.sync_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY sync_reports_select ON public.sync_reports FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);

CREATE POLICY sync_reports_insert ON public.sync_reports FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);

CREATE POLICY sync_reports_update ON public.sync_reports FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);

CREATE OR REPLACE FUNCTION public.touch_sync_reports_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER sync_reports_updated_at
  BEFORE UPDATE ON public.sync_reports
  FOR EACH ROW EXECUTE FUNCTION public.touch_sync_reports_updated_at();

GRANT SELECT, INSERT, UPDATE ON public.sync_reports TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- get_daily_sync_data(business_id, date) — returns a single jsonb row
-- aggregating audit_log + supplemental tables for the given date.
-- SECURITY DEFINER so it can read across audit_log + clients +
-- time_entries + job_applications without each caller needing
-- individual policies on every join target. RLS-gated at the
-- function-execution level: only owner/admin/manager can call.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_daily_sync_data(
  p_business_id uuid,
  p_date        date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_start timestamptz;
  v_end   timestamptz;
  v_result jsonb;
BEGIN
  -- Caller role gate. Even though SECURITY DEFINER bypasses RLS, we
  -- want to enforce that only manager-tier users in the SAME tenant
  -- can call.
  SELECT u.role INTO v_role
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
    AND u.business_id  = p_business_id
    AND u.deleted_at IS NULL
  LIMIT 1;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin','manager') THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'sync report requires owner/admin/manager role in target tenant';
  END IF;

  v_start := (p_date::timestamptz);
  v_end   := (p_date + INTERVAL '1 day')::timestamptz;

  WITH
  -- New clients today: audit_log 'created' events on entity_type='client'.
  new_clients AS (
    SELECT
      a.entity_id AS client_id,
      a.new_values->>'first_name' AS first_name,
      a.new_values->>'last_name'  AS last_name,
      a.new_values->>'city'       AS city,
      a.created_at
    FROM public.audit_log a
    WHERE a.business_id = p_business_id
      AND a.entity_type = 'client'
      AND a.action_type = 'created'
      AND a.created_at >= v_start
      AND a.created_at <  v_end
  ),
  -- Client deletions today: 'deleted' events on entity_type='client'.
  client_dels AS (
    SELECT
      a.entity_id AS client_id,
      COALESCE(a.new_values, a.old_values)->>'first_name' AS first_name,
      COALESCE(a.new_values, a.old_values)->>'last_name'  AS last_name,
      a.created_at
    FROM public.audit_log a
    WHERE a.business_id = p_business_id
      AND a.entity_type = 'client'
      AND a.action_type = 'deleted'
      AND a.created_at >= v_start
      AND a.created_at <  v_end
  ),
  -- Schedule changes: any audit row on entity_type='job' or
  -- 'daily_assignment'. Include cancellations.
  schedule_changes AS (
    SELECT
      a.entity_id,
      a.entity_type,
      a.action_type,
      a.new_values->>'client_name'   AS client_name,
      a.new_values->>'team'          AS team,
      a.new_values->>'date'          AS job_date,
      a.new_values                   AS new_values,
      a.created_at
    FROM public.audit_log a
    WHERE a.business_id = p_business_id
      AND a.entity_type IN ('job','daily_assignment')
      AND a.created_at >= v_start
      AND a.created_at <  v_end
  ),
  -- Time entries: every audit row on entity_type='time_entry'.
  -- Phase 1 collapses to "N employees clocked in/out today".
  time_entry_events AS (
    SELECT
      a.entity_id,
      a.action_type,
      a.new_values->>'employee_id' AS employee_id,
      a.new_values->>'clock_in_at'  AS clock_in_at,
      a.new_values->>'clock_out_at' AS clock_out_at,
      a.created_at
    FROM public.audit_log a
    WHERE a.business_id = p_business_id
      AND a.entity_type = 'time_entry'
      AND a.created_at >= v_start
      AND a.created_at <  v_end
  ),
  -- New applications: 'submitted' supplement events from the RPC.
  applications AS (
    SELECT
      a.entity_id AS application_id,
      a.new_values->>'applicant_name' AS applicant_name,
      a.new_values->>'hear_about_us'  AS hear_about_us,
      a.new_values->>'preferred_language' AS preferred_language,
      a.created_at
    FROM public.audit_log a
    WHERE a.business_id = p_business_id
      AND a.entity_type = 'application'
      AND a.action_type = 'submitted'
      AND a.created_at >= v_start
      AND a.created_at <  v_end
  )
  SELECT jsonb_build_object(
    'business_id', p_business_id,
    'report_date', p_date,
    'generated_at', now(),
    'new_clients', (SELECT COALESCE(jsonb_agg(to_jsonb(nc) ORDER BY nc.created_at), '[]'::jsonb) FROM new_clients nc),
    'new_clients_count', (SELECT COUNT(*) FROM new_clients),
    'client_deletions', (SELECT COALESCE(jsonb_agg(to_jsonb(cd) ORDER BY cd.created_at), '[]'::jsonb) FROM client_dels cd),
    'client_deletions_count', (SELECT COUNT(*) FROM client_dels),
    'schedule_changes', (SELECT COALESCE(jsonb_agg(to_jsonb(sc) ORDER BY sc.created_at), '[]'::jsonb) FROM schedule_changes sc),
    'schedule_changes_count', (SELECT COUNT(*) FROM schedule_changes),
    'time_entries', (SELECT COALESCE(jsonb_agg(to_jsonb(te) ORDER BY te.created_at), '[]'::jsonb) FROM time_entry_events te),
    'time_entries_count', (SELECT COUNT(*) FROM time_entry_events),
    'applications', (SELECT COALESCE(jsonb_agg(to_jsonb(ap) ORDER BY ap.created_at), '[]'::jsonb) FROM applications ap),
    'applications_count', (SELECT COUNT(*) FROM applications),
    'total_items',
      (SELECT COUNT(*) FROM new_clients) +
      (SELECT COUNT(*) FROM client_dels) +
      (SELECT COUNT(*) FROM schedule_changes) +
      (SELECT COUNT(*) FROM time_entry_events) +
      (SELECT COUNT(*) FROM applications)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_daily_sync_data(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_sync_data(uuid, date) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- mark_sync_report_synced(business_id, date, notes) — upserts the
-- per-day state row and stamps marked_synced_at + marked_synced_by.
-- Returns the resulting row.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_sync_report_synced(
  p_business_id uuid,
  p_date        date,
  p_notes       text DEFAULT NULL
)
RETURNS public.sync_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_result  public.sync_reports%ROWTYPE;
BEGIN
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
    AND u.business_id  = p_business_id
    AND u.deleted_at IS NULL
    AND u.role IN ('owner','admin','manager')
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'access_denied' USING HINT = 'sync mark requires owner/admin/manager role in target tenant';
  END IF;

  INSERT INTO public.sync_reports (
    business_id, report_date, generated_at,
    marked_synced_at, marked_synced_by, notes
  ) VALUES (
    p_business_id, p_date, now(),
    now(), v_user_id, p_notes
  )
  ON CONFLICT (business_id, report_date) DO UPDATE
    SET marked_synced_at = now(),
        marked_synced_by = v_user_id,
        notes = COALESCE(EXCLUDED.notes, public.sync_reports.notes),
        updated_at = now()
  RETURNING * INTO v_result;

  -- Write a corresponding audit event so the mark-synced action is
  -- itself part of the immutable audit trail.
  INSERT INTO public.audit_log (
    business_id, user_id, action_type, entity_type, entity_id,
    new_values, created_at
  ) VALUES (
    p_business_id, v_user_id, 'approved', 'system', v_result.id,
    jsonb_build_object('sync_report_date', p_date, 'notes', p_notes),
    now()
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_sync_report_synced(uuid, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_sync_report_synced(uuid, date, text) TO authenticated;
