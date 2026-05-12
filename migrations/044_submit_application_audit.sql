-- v11.0.6 — Audit log foundation, part 3 supplement.
--
-- submit_job_application is SECURITY DEFINER and the only path public
-- (anon) applicants use. The trigger on job_applications will fire
-- action_type='created' automatically when this RPC inserts. We ALSO
-- want a richer 'submitted' event capturing:
--   - the slug the form was loaded with
--   - the applicant's name (for the Sync Report's daily summary)
--   - the preferred_language (signals which language path was used)
--
-- Two rows per application going forward (one trigger, one supplement)
-- with distinct action_types — Sync Report can use whichever is
-- richer; analytics queries can dedupe by entity_id.

CREATE OR REPLACE FUNCTION public.submit_job_application(
  p_slug    text,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz_id uuid;
  v_app_id uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_biz_id
  FROM public.businesses
  WHERE slug = lower(trim(p_slug))
    AND deleted_at IS NULL
  LIMIT 1;

  IF v_biz_id IS NULL THEN
    RAISE EXCEPTION 'unknown_business_slug' USING HINT = p_slug;
  END IF;

  IF (p_payload->>'first_name') IS NULL OR (p_payload->>'last_name') IS NULL OR (p_payload->>'phone') IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING HINT = 'first_name, last_name, phone all required';
  END IF;

  INSERT INTO public.job_applications (
    id, business_id, first_name, last_name, phone, email,
    address, city, state, zip_code,
    preferred_language,
    work_authorization, drivers_license_status, has_reliable_transportation,
    available_days, preferred_start_time, hours_per_week_desired, earliest_start_date,
    prior_cleaning_experience, prior_employer,
    emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
    hear_about_us, referred_by,
    prior_cleaning_experience_en, emergency_contact_relation_en,
    signature_full_name, signature_date_iso,
    driver_license_front_url, driver_license_back_url, ssn_card_url, passport_url,
    status, submitted_at
  )
  VALUES (
    v_app_id, v_biz_id,
    p_payload->>'first_name', p_payload->>'last_name', p_payload->>'phone', p_payload->>'email',
    p_payload->>'address', p_payload->>'city', p_payload->>'state', p_payload->>'zip_code',
    COALESCE(p_payload->>'preferred_language', 'en'),
    p_payload->>'work_authorization', p_payload->>'drivers_license_status',
      NULLIF(p_payload->>'has_reliable_transportation','')::boolean,
    p_payload->>'available_days', p_payload->>'preferred_start_time',
    p_payload->>'hours_per_week_desired', NULLIF(p_payload->>'earliest_start_date','')::date,
    p_payload->>'prior_cleaning_experience', p_payload->>'prior_employer',
    p_payload->>'emergency_contact_name', p_payload->>'emergency_contact_phone',
      p_payload->>'emergency_contact_relation',
    p_payload->>'hear_about_us', p_payload->>'referred_by',
    p_payload->>'prior_cleaning_experience_en', p_payload->>'emergency_contact_relation_en',
    p_payload->>'signature_full_name',
      COALESCE(NULLIF(p_payload->>'signature_date_iso','')::timestamptz, now()),
    p_payload->>'driver_license_front_url', p_payload->>'driver_license_back_url',
    p_payload->>'ssn_card_url', p_payload->>'passport_url',
    'new', now()
  );

  -- v11.0.6: app-level supplement audit event. action_type='submitted'
  -- distinct from the trigger's auto-fired 'created'. NULL user_id
  -- (anon caller). Captures the slug + applicant identity for Sync
  -- Report and recruiting-funnel analytics.
  INSERT INTO public.audit_log (
    business_id, user_id, action_type, entity_type, entity_id,
    new_values, created_at
  ) VALUES (
    v_biz_id, NULL, 'submitted', 'application', v_app_id,
    jsonb_build_object(
      'slug', lower(trim(p_slug)),
      'applicant_name',
        trim(COALESCE(p_payload->>'first_name','') || ' ' || COALESCE(p_payload->>'last_name','')),
      'phone', p_payload->>'phone',
      'preferred_language', COALESCE(p_payload->>'preferred_language', 'en'),
      'hear_about_us', p_payload->>'hear_about_us'
    ),
    now()
  );

  RETURN v_app_id;
END;
$$;
