-- Sprint 11.5+ Phase 4 follow-up — teammate display RPC for employee-side UI.
--
-- The employees_select policy correctly restricts non-manager reads to the
-- requester's own row (employees should not see teammates' pay_rate, address,
-- ssn_last4, manager_notes, emergency contacts, etc.). But the rewards UI
-- needs OTHER teammates' display data for: leaderboard rendering, gift
-- recipient picker, "gift from <name>" toasts, my-submissions cards, etc.
-- Without this, the picker rendered "Teammate <uuid-prefix>" synthetic stubs
-- because PentaEmployees.listSync() returned only the signed-in employee.
--
-- This RPC uses SECURITY DEFINER to bypass per-row RLS for a narrow,
-- display-safe column set scoped to the requester's own business. No
-- sensitive HR fields exposed.
--
-- Scope mirrors the existing employees_select policy: same business via
-- users.business_id, deleted_at IS NULL. Adds terminated_at IS NULL since
-- terminated employees shouldn't surface in the rewards UI.

CREATE OR REPLACE FUNCTION public.get_business_teammates()
RETURNS TABLE (
  id              uuid,
  first_name      text,
  last_name       text,
  photo_url       text,
  is_team_leader  boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.first_name, e.last_name, e.photo_url, e.is_team_leader
  FROM public.employees e
  WHERE e.business_id IN (
    SELECT u.business_id FROM public.users u WHERE u.id = auth.uid()
  )
  AND e.deleted_at IS NULL
  AND e.terminated_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.get_business_teammates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_business_teammates() TO authenticated;
