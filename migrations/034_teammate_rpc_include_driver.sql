-- Sprint 11.7 — extend get_business_teammates() to include is_driver.
--
-- v10.5.39: the employee team-today chip card and any other RPC reader
-- needs to know whether each teammate is a driver so we can render the 🚗
-- emoji next to their name (mirrors the ★ for team leaders). Adds one
-- boolean column to the existing function's RETURNS TABLE.
--
-- DROP + CREATE pattern: CREATE OR REPLACE rejects column-set changes on
-- RETURNS TABLE functions. Permissions re-granted post-create.

DROP FUNCTION IF EXISTS public.get_business_teammates();

CREATE OR REPLACE FUNCTION public.get_business_teammates()
RETURNS TABLE (
  id              uuid,
  first_name      text,
  last_name       text,
  photo_url       text,
  is_team_leader  boolean,
  is_driver       boolean,
  team_text       text,
  team_id         uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.first_name, e.last_name, e.photo_url, e.is_team_leader, e.is_driver, e.team_text, e.team_id
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
