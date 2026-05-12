-- v11.0.0 Item 2 — tighten the only anonymous INSERT policy.
--
-- The 96-table INSERT WITH CHECK audit found exactly one gap:
-- job_applications_public_insert had `WITH CHECK true` on role `anon`.
-- That means anonymous traffic could insert rows with any business_id
-- — even ones that don't exist or belong to other tenants — and
-- pollute the applications queue across the platform.
--
-- We need to keep anonymous inserts working (the public job
-- application form is unauthenticated by design — applicants don't
-- have accounts), but constrain the surface:
--   1. business_id must be NOT NULL
--   2. business_id must reference a real, non-deleted business
--
-- Item 3 will replace the direct INSERT with a SECURITY DEFINER RPC
-- (submit_job_application(slug, payload)) and revoke this anon policy
-- entirely. This migration is a stepping stone — closes the spoof
-- gap immediately without breaking the form.

DROP POLICY IF EXISTS job_applications_public_insert ON public.job_applications;

CREATE POLICY job_applications_public_insert ON public.job_applications
FOR INSERT
TO anon, authenticated
WITH CHECK (
  business_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = business_id
      AND b.deleted_at IS NULL
  )
);
