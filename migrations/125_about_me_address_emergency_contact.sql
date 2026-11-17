-- Hire-transfer-missing-fields fix. get_my_about_me() (migration 120)
-- was deliberately scoped to role/team, tenure, pay, and vacation only
-- ("no vehicle info per spec") -- it never showed an employee her own
-- address or emergency contact, so there was nowhere on the employee-
-- facing side to even notice those fields were missing after a hire.
-- Both are personal data about HERSELF, already visible to her
-- manager, so showing them back to her here is a reasonable, bounded
-- extension of an existing self-service RPC (SECURITY DEFINER, scoped
-- to auth.uid() already) -- not a new access-control decision.
--
-- Deliberately NOT added here: experience/availability/work-auth/
-- license/prior-employer/transportation/earliest-start-date -- those
-- read more like internal hiring-process data than "about me" personal
-- info, and About Me's own existing scope note argues for keeping it
-- narrow. Tom can ask for more if he wants a fuller profile screen.
--
-- Run twice safely: CREATE OR REPLACE.

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
    'vacation_text', 'Not set up yet',
    -- Hire-transfer-missing-fields fix: her own address + emergency
    -- contact, already visible to her manager -- null-safe, each key
    -- present even when unset so the client never has to guess.
    'address', v_emp.address,
    'city', v_emp.city,
    'state', v_emp.state,
    'zip', v_emp.zip,
    'emergency_contact_name', v_emp.emergency_contact_name,
    'emergency_contact_phone', v_emp.emergency_contact_phone,
    'emergency_contact_relationship', v_emp.emergency_contact_relationship
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
-- Re-run migration 120's own CREATE OR REPLACE body to restore the
-- narrower version (role/team, tenure, pay, vacation only).

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run after applying; see also tools/verify_125.sql)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT prosrc FROM pg_proc WHERE proname = 'get_my_about_me';
-- -- confirm the new keys appear in the function body above.
