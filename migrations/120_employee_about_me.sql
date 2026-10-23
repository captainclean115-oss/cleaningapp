-- Employee portal polish: "About me" read-only screen + the owner-only
-- "show pay in About me" setting.
--
-- get_my_about_me(): SECURITY DEFINER, returns ONLY the calling
-- employee's own fields, as a single jsonb object. When the business
-- setting is off, the pay_rate/pay_type keys are not included in the
-- returned object at all (not just nulled) -- confirmed by reading the
-- function body below, not just by convention.
--
-- No vacation/PTO balance exists anywhere in this schema today (only
-- time_off_requests, a request-tracking table with no balance/accrual
-- column) -- vacation_text is always 'Not set up yet' until a real
-- balance mechanism exists; Tom will decide those rules separately.
--
-- Run twice safely: CREATE OR REPLACE throughout.

-- 1. Owner-only setting, stored in businesses.business_settings (an
-- existing generic jsonb column -- no new column needed). Key:
-- show_pay_in_about_me, boolean, default true (absent key == on).
CREATE OR REPLACE FUNCTION public.set_show_pay_in_about_me(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_biz_id uuid;
  v_role public.user_role;
BEGIN
  SELECT business_id, role INTO v_biz_id, v_role FROM public.users WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the owner can change this setting';
  END IF;

  UPDATE public.businesses
  SET business_settings = COALESCE(business_settings, '{}'::jsonb) || jsonb_build_object('show_pay_in_about_me', p_enabled)
  WHERE id = v_biz_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_show_pay_in_about_me(boolean) TO authenticated;

-- 2. The read-only About-me RPC itself.
CREATE OR REPLACE FUNCTION public.get_my_about_me()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_emp record;
  v_show_pay boolean;
  v_result jsonb;
  v_team_label text;
  v_tenure_text text;
  v_months integer;
  v_years integer;
  v_rem_months integer;
BEGIN
  SELECT e.*, (SELECT b.business_settings FROM public.businesses b WHERE b.id = e.business_id) AS biz_settings
  INTO v_emp
  FROM public.employees e
  WHERE e.auth_user_id = auth.uid() AND e.deleted_at IS NULL;

  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'No active employee record for the current user';
  END IF;

  v_show_pay := COALESCE((v_emp.biz_settings->>'show_pay_in_about_me')::boolean, true);

  -- Role/team label -- no vehicle info (per spec). work_type='admin'
  -- shows as Admin/Office; otherwise her team name, or "Unassigned".
  IF v_emp.work_type = 'admin' THEN
    v_team_label := 'Admin/Office';
  ELSE
    SELECT t.name INTO v_team_label FROM public.teams t WHERE t.id = v_emp.team_id;
    v_team_label := COALESCE(v_team_label, v_emp.team_text, 'Unassigned');
  END IF;

  -- Tenure: "<N> years, <M> months" from hired_at, or "Not set".
  IF v_emp.hired_at IS NULL THEN
    v_tenure_text := 'Not set';
  ELSE
    v_months := (DATE_PART('year', age(CURRENT_DATE, v_emp.hired_at)) * 12 + DATE_PART('month', age(CURRENT_DATE, v_emp.hired_at)))::integer;
    IF v_months < 0 THEN v_months := 0; END IF;
    v_years := v_months / 12;
    v_rem_months := v_months % 12;
    IF v_years = 0 AND v_rem_months = 0 THEN
      v_tenure_text := 'Less than a month';
    ELSIF v_years = 0 THEN
      v_tenure_text := v_rem_months || ' month' || (CASE WHEN v_rem_months = 1 THEN '' ELSE 's' END);
    ELSIF v_rem_months = 0 THEN
      v_tenure_text := v_years || ' year' || (CASE WHEN v_years = 1 THEN '' ELSE 's' END);
    ELSE
      v_tenure_text := v_years || ' year' || (CASE WHEN v_years = 1 THEN '' ELSE 's' END) || ', ' || v_rem_months || ' month' || (CASE WHEN v_rem_months = 1 THEN '' ELSE 's' END);
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'name', trim(v_emp.first_name || ' ' || v_emp.last_name),
    'team_label', v_team_label,
    'tenure_text', v_tenure_text,
    'pay_type', v_emp.pay_type,
    -- vacation_text is ALWAYS this -- no balance/accrual exists
    -- anywhere in this schema (time_off_requests tracks requests, not
    -- a running balance). Do not infer one.
    'vacation_text', 'Not set up yet'
  );

  IF v_show_pay THEN
    v_result := v_result || jsonb_build_object('pay_rate', v_emp.pay_rate, 'show_pay', true);
  ELSE
    v_result := v_result || jsonb_build_object('show_pay', false);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_about_me() TO authenticated;

-- ROLLBACK
-- DROP FUNCTION IF EXISTS public.get_my_about_me();
-- DROP FUNCTION IF EXISTS public.set_show_pay_in_about_me(boolean);
-- (business_settings is pre-existing/generic -- no column to drop; the
--  show_pay_in_about_me key can be removed with:
--  UPDATE public.businesses SET business_settings = business_settings - 'show_pay_in_about_me';)

-- VERIFY
-- select proname from pg_proc where proname in ('get_my_about_me','set_show_pay_in_about_me');
