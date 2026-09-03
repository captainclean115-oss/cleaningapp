-- PR #158 -- closes a gap PR #157 (migration 108) missed: deleting an
-- employee cleaned up employees + auth.users but left public.users
-- behind entirely untouched. public.users has NO foreign key to
-- auth.users at all (confirmed: it's matched by convention, id ==
-- auth_user_id, not database-enforced) -- so it doesn't get cleaned up
-- by anything else either.
--
-- Confirmed live, real incident: Tom deleted a test employee whose
-- public.users row had role='owner' (explicitly set earlier for a real
-- reason unrelated to this bug). The employees + auth.users rows were
-- correctly removed by migration 108's RPC, but the orphaned
-- public.users row survived with role='owner' still attached to that
-- email. accept-invite's "preserve role" logic (built for a real,
-- different, legitimate case -- carrying a pre-assigned manager role
-- across into a fresh invite acceptance) matches by business_id + email,
-- found this orphaned row, and "preserved" its stale owner role onto a
-- brand-new hire under the same email -- who should have landed as a
-- plain employee. Result: a freshly-invited test employee got full
-- manager-tier (owner) access on login.
--
-- Fix: delete_employee_with_auth also deletes the linked public.users
-- row now, so no stale role can ever be inherited by a later re-invite
-- under the same email again. Wrapped in its own exception handler --
-- public.users has ~50+ NO ACTION FKs from audit-trail-style tables
-- (jobs.created_by, audit_log.user_id, etc.) that could theoretically
-- block this for a users row with real history; if that happens, the
-- employees + auth.users deletion (already proven safe) still completes
-- rather than the whole function aborting -- a warning is raised instead
-- so it's visible in logs, not silently swallowed.

CREATE OR REPLACE FUNCTION public.delete_employee_with_auth(p_employee_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_employee_business_id uuid;
  v_auth_user_id         uuid;
  v_caller_business_id   uuid;
  v_caller_role          user_role;
BEGIN
  SELECT business_id, role INTO v_caller_business_id, v_caller_role
  FROM public.users WHERE id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'Not authorized to delete employees';
  END IF;

  SELECT business_id, auth_user_id INTO v_employee_business_id, v_auth_user_id
  FROM public.employees WHERE id = p_employee_id;

  IF v_employee_business_id IS NULL THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF v_employee_business_id IS DISTINCT FROM v_caller_business_id THEN
    RAISE EXCEPTION 'Not authorized to delete this employee';
  END IF;

  DELETE FROM public.employees WHERE id = p_employee_id;

  IF v_auth_user_id IS NOT NULL THEN
    BEGIN
      DELETE FROM public.users WHERE id = v_auth_user_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[delete_employee_with_auth] could not delete public.users row % (non-fatal, employee/auth deletion still completes): %', v_auth_user_id, SQLERRM;
    END;
    DELETE FROM auth.users WHERE id = v_auth_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_employee_with_auth(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_employee_with_auth(uuid) TO authenticated;
