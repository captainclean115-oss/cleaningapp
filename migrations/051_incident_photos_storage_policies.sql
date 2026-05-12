-- v11.0.12 — Storage RLS policies for the 'incident-photos' bucket.
--
-- PREREQ: Tom must create the bucket in Supabase Dashboard before
-- testing photo upload. Steps:
--   Dashboard → Storage → New bucket
--     Name:       incident-photos
--     Public:     OFF (private)
--     File size:  10 MB
--     MIME types: image/jpeg, image/png, image/webp, image/heic
--
-- These policies live on storage.objects and reference the bucket by
-- name. Creating policies BEFORE the bucket exists is fine — the
-- policies just won't match any rows until objects start landing in
-- that bucket. So this migration is safe to apply ahead of bucket
-- creation.
--
-- Path convention enforced by the app: <business_id>/<incident_id>/photo.<ext>
-- Tenant isolation comes from the path prefix matching a row in
-- public.incidents that belongs to the caller's business.

-- Idempotent: drop any prior policies of these names before recreate.
DROP POLICY IF EXISTS incident_photos_select ON storage.objects;
DROP POLICY IF EXISTS incident_photos_insert ON storage.objects;
DROP POLICY IF EXISTS incident_photos_update ON storage.objects;
DROP POLICY IF EXISTS incident_photos_delete ON storage.objects;

-- SELECT: same-business members can read.
-- Path-prefix match: the first path segment IS the business_id.
CREATE POLICY incident_photos_select ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'incident-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
);

-- INSERT: same-business members can upload (employee + manager).
CREATE POLICY incident_photos_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'incident-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
);

-- UPDATE: manager-tier only (resolve flow may swap photos).
CREATE POLICY incident_photos_update ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'incident-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);

-- DELETE: manager-tier only.
CREATE POLICY incident_photos_delete ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'incident-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);
