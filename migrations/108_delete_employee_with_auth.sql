-- PR #157 -- fixes a real gap found live: PR #155's PentaEmployees.
-- hardDelete() only ran `DELETE FROM employees`, which correctly cascades
-- real app data (daily_assignments, time_entries, reward_ledger, forms,
-- etc.) but leaves the employee's auth.users row (if they'd ever accepted
-- an invite / set a password) completely orphaned -- employees.
-- auth_user_id -> auth.users.id is ON DELETE SET NULL, not cascading, so
-- deleting the employees row just nulls the link and the auth identity
-- survives forever with no employees row pointing to it.
--
-- Confirmed live: this is exactly what blocked Tom re-inviting the same
-- test email today. He deleted an old test employee (via PR #155) who'd
-- already set a password; the underlying auth.users row for that email
-- survived, unlinked. A NEW application + hire under the same email
-- later tried to accept-invite (auth.admin.createUser) and failed --
-- Supabase Auth enforces email uniqueness across auth.users regardless
-- of which employees row a JS session cares about.
--
-- The browser's anon/authenticated Supabase client can't delete from
-- auth.users directly (PostgREST doesn't expose the auth schema, and
-- auth.admin.deleteUser() needs the service-role key, never in the
-- browser bundle). A SECURITY DEFINER RPC is the only way to do this
-- from client code -- explicitly business-scoped and role-checked here
-- (same authorization the employees_delete RLS policy already enforces:
-- caller must be owner/admin/manager of the SAME business as the target
-- employee) so this can't be used to delete an arbitrary auth identity
-- outside the caller's own tenant.

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
    DELETE FROM auth.users WHERE id = v_auth_user_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_employee_with_auth(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_employee_with_auth(uuid) TO authenticated;
