-- v11.0.16 — Storage RLS policies for the 'payment-photos' bucket.
--
-- PREREQ: Tom must create the bucket in Supabase Dashboard before
-- testing photo upload. Same shape as incident-photos:
--   Dashboard → Storage → New bucket
--     Name:       payment-photos
--     Public:     OFF
--     File size:  10 MB
--     MIME types: image/jpeg, image/png, image/webp, image/heic
--
-- Policies live on storage.objects and reference the bucket by name.
-- Safe to apply before the bucket exists — policies just don't match
-- anything until objects start landing in that bucket.
--
-- Path convention enforced by the app: <business_id>/<payment_id>/photo.<ext>

DROP POLICY IF EXISTS payment_photos_select ON storage.objects;
DROP POLICY IF EXISTS payment_photos_insert ON storage.objects;
DROP POLICY IF EXISTS payment_photos_update ON storage.objects;
DROP POLICY IF EXISTS payment_photos_delete ON storage.objects;

CREATE POLICY payment_photos_select ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'payment-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
);

CREATE POLICY payment_photos_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'payment-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
);

CREATE POLICY payment_photos_update ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'payment-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);

CREATE POLICY payment_photos_delete ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'payment-photos'
  AND (storage.foldername(name))[1] = (
    SELECT business_id::text FROM public.users WHERE auth_user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);
