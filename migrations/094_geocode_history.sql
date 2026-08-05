-- PR #93 — Geocode audit trail.
--
-- Backs the new per-client "Re-geocode" button and the Clients tab's
-- "Missing address geocode" batch flow. Every call to
-- window.PentaGeocode.geocodeAddress() made from either UI path writes
-- one row here, win or lose — useful for debugging (which provider
-- resolved/failed a given address) and for tracking call volume if the
-- geocoding provider ever starts billing per request.
--
-- Append-only: no UPDATE/DELETE policy, matching the job_issues (mig
-- 047) / incidents (mig 049) convention for audit-shaped tables.

CREATE TABLE public.geocode_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  client_id         uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  called_at         timestamptz NOT NULL DEFAULT now(),
  called_by         uuid REFERENCES public.users(id),
  address_at_time   text,
  result_lat        double precision,
  result_lng        double precision,
  result_status     text CHECK (result_status IN ('ok', 'failed', 'rate_limited')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_geocode_history_business_client
  ON public.geocode_history (business_id, client_id, called_at DESC);

ALTER TABLE public.geocode_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY geocode_history_select ON public.geocode_history FOR SELECT
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY geocode_history_insert ON public.geocode_history FOR INSERT
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

GRANT SELECT, INSERT ON public.geocode_history TO authenticated;
