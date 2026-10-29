-- Employee portal polish: self-service Account edit.
--
-- Context: employees_update's RLS policy today allows a real employee
-- session to UPDATE *any* column on her own employees row directly via
-- a plain REST call (not just the columns the app's own UI exposes) --
-- confirmed live by reading the policy: USING/WITH CHECK both reduce to
-- "auth_belongs_to_business AND (manager-tier OR auth_user_id =
-- auth.uid())", with no column restriction at all for the self-update
-- branch. That means pay_rate, status, team_id, auth_user_id -- every
-- column -- is currently writable by her directly if she (or a script
-- using her real browser session) calls the REST API outside the app's
-- own UI. This migration closes that specific gap: the self-service
-- branch is removed from employees_update, and a SECURITY DEFINER RPC
-- (update_my_employee_profile) becomes the only path for an employee to
-- change anything on her own row -- it bypasses RLS internally but only
-- ever touches a fixed, small column whitelist.
--
-- Also adds `preferred_language` -- no existing column captured "what
-- language does she want the UI in" (culture_tag is a manager-set
-- demographic tag, languages_spoken is "what languages can she speak"
-- from the job application -- neither is the right fit to repurpose).
--
-- Run twice safely: every object uses IF NOT EXISTS / CREATE OR REPLACE
-- / DROP POLICY IF EXISTS before CREATE POLICY.

-- 1. New column.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS preferred_language text;

COMMENT ON COLUMN public.employees.preferred_language IS
  'Employee-chosen portal UI language (en/es/pt/cv). NULL means no explicit choice yet -- falls back to culture_tag''s derived default, then en. Set only via update_my_employee_profile() or a manager''s Staff edit, never by the employee directly updating her own row.';

-- 2. Tighten employees_update: remove the self-service UPDATE branch.
-- Managers/owners/admins keep full UPDATE access (Staff edit, hire,
-- terminate, etc.) -- unchanged. An employee can no longer UPDATE her
-- own row at all via a direct REST call; update_my_employee_profile()
-- (SECURITY DEFINER, below) is now the only self-service write path.
DROP POLICY IF EXISTS employees_update ON public.employees;
CREATE POLICY employees_update ON public.employees
  FOR UPDATE
  TO authenticated
  USING (
    auth_belongs_to_business(business_id)
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin', 'manager')
    )
  )
  WITH CHECK (
    auth_belongs_to_business(business_id)
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin', 'manager')
    )
  );

-- 3. The self-service RPC. Whitelist: home address (address/city/state/
-- zip), emergency contact name + phone, preferred_language. Never phone
-- (that's her login -- changing it breaks sign-in, per the app's own
-- read-only-with-"contact the office" treatment), never name, never
-- pay_rate/status/team_id/anything else. NULL means "leave unchanged"
-- for every parameter -- a caller passing only p_preferred_language
-- changes just that one field.
CREATE OR REPLACE FUNCTION public.update_my_employee_profile(
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_zip text DEFAULT NULL,
  p_emergency_contact_name text DEFAULT NULL,
  p_emergency_contact_phone text DEFAULT NULL,
  p_preferred_language text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_emp_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_changed jsonb := '{}'::jsonb;
BEGIN
  IF p_preferred_language IS NOT NULL AND p_preferred_language NOT IN ('en', 'es', 'pt', 'cv') THEN
    RAISE EXCEPTION 'Unknown language code: %', p_preferred_language;
  END IF;

  SELECT id INTO v_emp_id
  FROM public.employees
  WHERE auth_user_id = auth.uid() AND deleted_at IS NULL;

  IF v_emp_id IS NULL THEN
    RAISE EXCEPTION 'No active employee record for the current user';
  END IF;

  SELECT jsonb_build_object(
    'address', address, 'city', city, 'state', state, 'zip', zip,
    'emergency_contact_name', emergency_contact_name,
    'emergency_contact_phone', emergency_contact_phone,
    'preferred_language', preferred_language
  ) INTO v_old
  FROM public.employees WHERE id = v_emp_id;

  UPDATE public.employees SET
    address = COALESCE(p_address, address),
    city = COALESCE(p_city, city),
    state = COALESCE(p_state, state),
    zip = COALESCE(p_zip, zip),
    emergency_contact_name = COALESCE(p_emergency_contact_name, emergency_contact_name),
    emergency_contact_phone = COALESCE(p_emergency_contact_phone, emergency_contact_phone),
    preferred_language = COALESCE(p_preferred_language, preferred_language),
    updated_at = now()
  WHERE id = v_emp_id;

  SELECT jsonb_build_object(
    'address', address, 'city', city, 'state', state, 'zip', zip,
    'emergency_contact_name', emergency_contact_name,
    'emergency_contact_phone', emergency_contact_phone,
    'preferred_language', preferred_language
  ) INTO v_new
  FROM public.employees WHERE id = v_emp_id;

  IF p_address IS NOT NULL THEN v_changed := v_changed || jsonb_build_object('address', jsonb_build_object('old', v_old->'address', 'new', v_new->'address')); END IF;
  IF p_city IS NOT NULL THEN v_changed := v_changed || jsonb_build_object('city', jsonb_build_object('old', v_old->'city', 'new', v_new->'city')); END IF;
  IF p_state IS NOT NULL THEN v_changed := v_changed || jsonb_build_object('state', jsonb_build_object('old', v_old->'state', 'new', v_new->'state')); END IF;
  IF p_zip IS NOT NULL THEN v_changed := v_changed || jsonb_build_object('zip', jsonb_build_object('old', v_old->'zip', 'new', v_new->'zip')); END IF;
  IF p_emergency_contact_name IS NOT NULL THEN v_changed := v_changed || jsonb_build_object('emergency_contact_name', jsonb_build_object('old', v_old->'emergency_contact_name', 'new', v_new->'emergency_contact_name')); END IF;
  IF p_emergency_contact_phone IS NOT NULL THEN v_changed := v_changed || jsonb_build_object('emergency_contact_phone', jsonb_build_object('old', v_old->'emergency_contact_phone', 'new', v_new->'emergency_contact_phone')); END IF;
  IF p_preferred_language IS NOT NULL THEN v_changed := v_changed || jsonb_build_object('preferred_language', jsonb_build_object('old', v_old->'preferred_language', 'new', v_new->'preferred_language')); END IF;

  -- Supplementary audit row with source='employee_self_edit' and ONLY
  -- the changed fields (old/new) -- no sensitive extras (no ssn, no
  -- pay_rate, nothing beyond this whitelist, which never included
  -- those). The table's existing audit_log_capture trigger ALSO fires
  -- on this UPDATE (action_type='updated', full old/new row diff) --
  -- that's the can't-miss floor; this is the same "why" supplement
  -- pattern _auditSupplement already uses elsewhere in this app.
  BEGIN
    INSERT INTO public.audit_log (business_id, user_id, action_type, entity_type, entity_id, new_values)
    SELECT e.business_id, NULL, 'manual_note', 'employee', v_emp_id,
           jsonb_build_object('source', 'employee_self_edit', 'changed_fields', v_changed)
    FROM public.employees e WHERE e.id = v_emp_id;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- best-effort, never blocks the actual save
  END;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_my_employee_profile(text, text, text, text, text, text, text) TO authenticated;

-- ROLLBACK
-- DROP FUNCTION IF EXISTS public.update_my_employee_profile(text, text, text, text, text, text, text);
-- DROP POLICY IF EXISTS employees_update ON public.employees;
-- CREATE POLICY employees_update ON public.employees
--   FOR UPDATE TO authenticated
--   USING (auth_belongs_to_business(business_id) AND (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager')) OR auth_user_id = auth.uid()))
--   WITH CHECK (auth_belongs_to_business(business_id) AND (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager')) OR auth_user_id = auth.uid()));
-- ALTER TABLE public.employees DROP COLUMN IF EXISTS preferred_language;

-- VERIFY
-- select proname from pg_proc where proname = 'update_my_employee_profile';
-- select policyname, pg_get_expr(polqual, polrelid) from pg_policy where polrelid = 'public.employees'::regclass and polname='employees_update';
-- select column_name from information_schema.columns where table_name='employees' and column_name='preferred_language';
