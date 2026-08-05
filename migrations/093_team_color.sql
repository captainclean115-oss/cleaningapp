-- 093 — Team color feature (PR #90).
--
-- teams.color already exists (text, nullable, no default, no format
-- check) -- added at some earlier point but never wired to an editable
-- UI or a write path beyond PentaTeams.create()'s optional param. This
-- migration: adds a format CHECK, a column DEFAULT for brand-new rows,
-- backfills any row still missing a color with a sequential preset
-- (per business, ordered by display_order), and makes teams auditable
-- for the first time (no audit_teams_capture trigger existed before).
--
-- Manna's 8 active teams already have real (legacy-map-derived) colors
-- -- the backfill below is a no-op for them today, but is real
-- protection for any other tenant/future team with color IS NULL.

ALTER TABLE public.teams
  ALTER COLUMN color SET DEFAULT '#3B82F6';

ALTER TABLE public.teams
  ADD CONSTRAINT teams_color_format_check
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');

-- Sequential preset backfill, 10-color palette, wraps with % 10 if a
-- business somehow has more than 10 teams.
WITH ordered AS (
  SELECT id, business_id,
    ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY display_order, created_at) - 1 AS idx
  FROM public.teams
  WHERE color IS NULL
),
palette (i, hex) AS (
  VALUES
    (0,'#EF4444'), (1,'#F97316'), (2,'#F59E0B'), (3,'#10B981'), (4,'#14B8A6'),
    (5,'#06B6D4'), (6,'#3B82F6'), (7,'#6366F1'), (8,'#A855F7'), (9,'#EC4899')
)
UPDATE public.teams t
SET color = p.hex
FROM ordered o JOIN palette p ON p.i = (o.idx % 10)
WHERE t.id = o.id;

COMMENT ON COLUMN public.teams.color IS 'Hex color (#RRGGBB), user-editable via Staff -> Teams -> click team -> Team Color. New teams default to #3B82F6 (Blue); existing teams missing a color get a sequential preset from the 10-color palette (migration 093 backfill). Resolved app-wide via _pentaTeamColor()/PentaTeams.getByName(), never read directly except in a few older call sites still being consolidated onto that resolver.';

-- ── audit_log_capture(): teams entity_type + auditability ─────────
-- No audit_teams_capture trigger existed before this -- teams changes
-- (including color) were never logged. Adds the CASE mapping ('team',
-- matching the singular convention every other entity_type uses) and
-- attaches the same generic trigger already used by clients/jobs/etc.
-- Falls into the generic 'updated' action bucket (no team-specific
-- semantic action needed, unlike jobs.cancelled_at/clients.cancelled_at).
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

CREATE TRIGGER audit_teams_capture
  AFTER INSERT OR DELETE OR UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_capture();
