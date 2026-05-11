-- Sprint 11.6 — extend get_business_teammates() to include team info.
--
-- The schedule view's team-today roster (above the clock-in button) needs to
-- know each teammate's team_text to filter. Migration 030's RPC only returned
-- name + photo + TL flag — fine for the rewards gift picker, but not enough
-- for the schedule. Now also returns team_text + team_id.
--
-- Postgres won't allow CREATE OR REPLACE on a RETURNS TABLE function when
-- the column set changes — must DROP first. Idempotent (IF EXISTS).
-- Permissions re-granted post-create.

DROP FUNCTION IF EXISTS public.get_business_teammates();

CREATE OR REPLACE FUNCTION public.get_business_teammates()
RETURNS TABLE (
  id              uuid,
  first_name      text,
  last_name       text,
  photo_url       text,
  is_team_leader  boolean,
  team_text       text,
  team_id         uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.first_name, e.last_name, e.photo_url, e.is_team_leader, e.team_text, e.team_id
  FROM public.employees e
  WHERE e.business_id IN (
    SELECT u.business_id FROM public.users u WHERE u.id = auth.uid()
  )
  AND e.deleted_at IS NULL
  AND e.terminated_at IS NULL
  AND e.status = 'active';
$$;

REVOKE ALL ON FUNCTION public.get_business_teammates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_business_teammates() TO authenticated;
