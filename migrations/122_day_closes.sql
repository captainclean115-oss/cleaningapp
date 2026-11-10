-- Close Day (PR: close-day). Owner/admin-only "close this day's data"
-- workflow in the Schedule tab.
--
-- Context: job_visit_snapshots (migration 121) already supports
-- everything needed at the per-JOB grain for Close Day's edits --
-- manually_edited, status (including 'skipped', usable for a job
-- cancelled during review), free-text match_note, free-text source
-- (a new 'manual' value for an added/linked job needs no CHECK
-- change -- that column has never had one), and editable in_at/out_at/
-- team_minutes. NOTHING on that table needs to change for this
-- feature -- confirmed by walking every item Close Day needs to
-- record (cancelled job, added job, manually linked stop, edited in/
-- out, flag resolution note) against its existing columns.
--
-- What's missing is TEAM-DAY-grain state that doesn't fit a job-keyed
-- row at all: each team's lunch start/minutes for that day, and a
-- review decision for a GPS stop that matches NO job and NO client
-- (there's nothing to attach that decision to in job_visit_snapshots).
-- lunch_flag_overrides already exists for a similar-shaped problem
-- (business_id/team/date/stop_key -> override_type), but its
-- override_type CHECK is hard-limited to ('exclude','include') for
-- lunch specifically, and it's a pre-existing table this feature was
-- told not to write to (Close Day's own writes go only to new/
-- extended snapshot tables). So: one new table. day_closes holds ONE
-- row per business per calendar day, closed_at/closed_by/reopened_at/
-- reopened_by for the audit trail, and flags_snapshot jsonb for every
-- team-day-grain detail (lunch, per-stop "not a client" review
-- decisions, unresolved-flag counts) as a single snapshot taken at
-- close time -- never written to piecemeal before that.
--
-- Owner/admin ONLY in RLS (SELECT/INSERT/UPDATE), matching
-- job_visit_snapshots/business_profit_targets (migration 121)'s own
-- stricter-than-usual gate. No DELETE policy -- a day is reopened
-- (status flips to 'open', data kept), never deleted.
--
-- Realtime: checked pg_publication_tables -- job_visit_snapshots,
-- business_profit_targets, AND lunch_flag_overrides (the nearest
-- precedent, same per-team-per-date grain) are all already NOT in the
-- realtime publication. Skipping it here too, for the same reason as
-- 121: no live multi-user view consumes this yet.
--
-- Run twice safely: IF NOT EXISTS / DROP POLICY IF EXISTS before
-- CREATE POLICY throughout.

CREATE TABLE IF NOT EXISTS public.day_closes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  close_date        date NOT NULL,
  status            text NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
  closed_at         timestamptz,
  closed_by         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reopened_at       timestamptz,
  reopened_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  note              text,
  -- Per-team lunch (start/minutes), per-stop "not a client" review
  -- decisions, and unresolved-flag counts for this day -- taken as one
  -- snapshot at close time. {} until the day is actually closed.
  flags_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, close_date)
);

ALTER TABLE public.day_closes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS day_closes_select ON public.day_closes;
CREATE POLICY day_closes_select ON public.day_closes FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

DROP POLICY IF EXISTS day_closes_insert ON public.day_closes;
CREATE POLICY day_closes_insert ON public.day_closes FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

DROP POLICY IF EXISTS day_closes_update ON public.day_closes;
CREATE POLICY day_closes_update ON public.day_closes FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
);

GRANT SELECT, INSERT, UPDATE ON public.day_closes TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (not applied -- run this block to undo everything above)
-- ═══════════════════════════════════════════════════════════════════════
-- DROP POLICY IF EXISTS day_closes_select ON public.day_closes;
-- DROP POLICY IF EXISTS day_closes_insert ON public.day_closes;
-- DROP POLICY IF EXISTS day_closes_update ON public.day_closes;
-- DROP TABLE IF EXISTS public.day_closes;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run after applying; see also tools/verify_122.sql)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='day_closes' ORDER BY ordinal_position;
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'public.day_closes'::regclass;
--
-- SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
-- FROM pg_policy WHERE polrelid = 'public.day_closes'::regclass;
--
-- SELECT schemaname, tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'day_closes';
-- (expected: zero rows -- not added to realtime, see comment above)
