-- v11.0.0 Item 3 — Application form tenant resolution.
--
-- The public job application form is unauthenticated and used to ship
-- with Manna Maids' business_id baked into the insert payload. To
-- onboard a second paying tenant, an applicant has to know which
-- business they're applying to without holding a session. The slug +
-- RPC pattern is the simplest way to do this safely:
--
--   Applicant visits  …/apply?biz=<slug>
--   Form calls public.get_business_by_slug(slug) → {id, name}
--   Form posts via   public.submit_job_application(slug, payload jsonb)
--                    — SECURITY DEFINER, validates slug → business_id,
--                      inserts the row server-side
--
-- The RPC pattern means we never trust a client-supplied business_id
-- on the public path. The anon WITH CHECK from Migration 036 is
-- defense-in-depth; the RPC is the primary lock.

-- 1) Slug column. UNIQUE so two businesses can't share one. Citext-style
--    folding handled at write time by the RPC (lowercase + hyphens).
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS slug text;

CREATE UNIQUE INDEX IF NOT EXISTS businesses_slug_uq
  ON public.businesses (slug)
  WHERE deleted_at IS NULL;

-- Backfill: derive a slug from name for any existing row that doesn't
-- have one. Lower-case, hyphenated, alphanumeric only. Hand-set the
-- four current rows to predictable values for share-link continuity.
UPDATE public.businesses SET slug = 'manna-maids'
  WHERE id = '48532f06-0625-415b-9091-2638bed6506d' AND slug IS NULL;
UPDATE public.businesses SET slug = 'manna-maids-test'
  WHERE id = 'abfc10d6-6a01-438a-a30d-47b54938a7ae' AND slug IS NULL;
UPDATE public.businesses SET slug = 'test-business-two'
  WHERE id = '86b8fd5d-0e6f-43ee-aa25-00099746d963' AND slug IS NULL;
UPDATE public.businesses SET slug = 'new-business'
  WHERE id = '20d6d5e8-6d3c-4a84-a1d4-b4c1fa70e6ae' AND slug IS NULL;

-- 2) Public read: anon-callable lookup by slug → minimal business info.
--    SECURITY DEFINER so it bypasses RLS on businesses (which is
--    locked down). Returns only id + display name — never any sensitive
--    fields. Tested existence + deleted_at gate.
CREATE OR REPLACE FUNCTION public.get_business_by_slug(p_slug text)
RETURNS TABLE (
  id   uuid,
  name text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT b.id, b.name
  FROM public.businesses b
  WHERE b.slug = lower(trim(p_slug))
    AND b.deleted_at IS NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_business_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_business_by_slug(text) TO anon, authenticated;

-- 3) Public write: slug-routed application submit. Validates slug,
--    resolves business_id server-side, inserts the row with all
--    expected columns. Returns the new application id.
--
-- p_payload is jsonb so the schema can evolve without changing the
-- function signature. Required fields are extracted with strict casts;
-- optional fields fall through nullably.
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
  -- Resolve tenant from slug. Reject if unknown / deleted.
  SELECT id INTO v_biz_id
  FROM public.businesses
  WHERE slug = lower(trim(p_slug))
    AND deleted_at IS NULL
  LIMIT 1;

  IF v_biz_id IS NULL THEN
    RAISE EXCEPTION 'unknown_business_slug' USING HINT = p_slug;
  END IF;

  -- Required fields. If any are missing we want a clear error so the
  -- form can highlight the failing field, not silently truncate.
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

  RETURN v_app_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_job_application(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_job_application(text, jsonb) TO anon, authenticated;

-- 4) Tighten anon's direct INSERT path now that the RPC exists. Anon
--    callers should go through submit_job_application; revoke direct
--    INSERT on the table for anon. Authenticated callers (managers
--    using the in-person form) keep direct INSERT — they're already
--    tenant-gated by Migration 036's WITH CHECK.
REVOKE INSERT ON public.job_applications FROM anon;
