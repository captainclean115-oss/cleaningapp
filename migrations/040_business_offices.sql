-- v11.0.4 (Issue A) — Per-tenant office/depot locations.
--
-- Manna Maids' two depots (Marlborough + Abington) lived as hardcoded
-- consts in index.html with GPS coords and team mappings. Every browser
-- that loaded the production app received them, regardless of tenant.
-- For a second paying tenant, that meant Manna's offices appeared as
-- pinned locations on their map and "back to depot" estimates routed
-- to Massachusetts addresses they'd never seen before.
--
-- Schema:
--   name        operator-visible label ("Marlborough", "South Office")
--   addr        full address (used as fallback for stop-vs-depot match)
--   lat/lng     GPS coords (used for radius geofence)
--   teams       which team codes consider this office their depot
--   radius_km   geofence radius for "is this stop AT the depot?"
--
-- RLS: any same-tenant user can SELECT (route optimization + drive-time
-- helpers fire on employee sessions). Write gated to owner/admin/manager.

CREATE TABLE public.business_offices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name         text NOT NULL,
  addr         text NOT NULL,
  lat          numeric(10,7),
  lng          numeric(10,7),
  teams        text[] NOT NULL DEFAULT '{}',
  radius_km    numeric NOT NULL DEFAULT 1.0,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE UNIQUE INDEX business_offices_name_uq
  ON public.business_offices (business_id, name)
  WHERE deleted_at IS NULL;

CREATE INDEX business_offices_business_idx
  ON public.business_offices (business_id)
  WHERE deleted_at IS NULL AND active = true;

ALTER TABLE public.business_offices ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_offices_select ON public.business_offices FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY business_offices_insert ON public.business_offices FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
              AND u.role IN ('owner','admin','manager'))
);

CREATE POLICY business_offices_update ON public.business_offices FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
              AND u.role IN ('owner','admin','manager'))
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
              AND u.role IN ('owner','admin','manager'))
);

CREATE POLICY business_offices_delete ON public.business_offices FOR DELETE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
              AND u.role IN ('owner','admin','manager'))
);

CREATE OR REPLACE FUNCTION public.touch_business_offices_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER business_offices_updated_at
  BEFORE UPDATE ON public.business_offices
  FOR EACH ROW EXECUTE FUNCTION public.touch_business_offices_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_offices TO authenticated;

-- Manna Maids backfill — port the two hardcoded depots.
INSERT INTO public.business_offices (business_id, name, addr, lat, lng, teams, radius_km, active)
VALUES
  ('48532f06-0625-415b-9091-2638bed6506d', 'Marlborough',
   '910 Boston Post Rd E, Marlborough, MA',
   42.3509580, -71.4948242,
   ARRAY['M1','M2','M3'],
   1.0, true),
  ('48532f06-0625-415b-9091-2638bed6506d', 'Abington',
   '800 Brockton Ave, Abington, MA',
   42.0932067, -70.9687121,
   ARRAY['B1','B3','B5','S1','S3'],
   1.0, true);
