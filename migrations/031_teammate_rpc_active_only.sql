-- Sprint 11.5+ Phase 4 follow-up — tighten teammate RPC to active employees only.
--
-- Migration 030 filtered deleted_at + terminated_at. Test data accumulated rows
-- with status='terminated' but BOTH terminated_at IS NULL AND deleted_at IS NULL
-- (legacy soft-archive shape) — those slipped through and surfaced on the
-- rewards leaderboard + gift picker. Adding status='active' as a third gate
-- catches that class of stale rows without affecting real employees.
--
-- Idempotent: CREATE OR REPLACE — re-applies cleanly if Migration 030 hasn't
-- run elsewhere.

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
  AND e.terminated_at IS NULL
  AND e.status = 'active';
$$;

-- Grant carried over from Migration 030 — no need to re-grant.
