-- v11.0.17 — Phase B.5: Client Request system.
--
-- Lightweight operational capture distinct from incidents. Employee
-- relays a request from the client ("they want to skip next clean"),
-- manager acknowledges. No photos, no status workflow — just one
-- acknowledged_at transition.
--
-- audit_log captures inserts + acknowledged_at NULL→NOT NULL via
-- mig 056's trigger extension.

CREATE TABLE public.client_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  job_id               uuid,
  client_id            uuid NOT NULL,
  reported_by          uuid REFERENCES public.users(id),
  request_type         text NOT NULL CHECK (request_type IN (
                         'skip_next_clean','add_service_today','reschedule',
                         'change_frequency','general_message','other'
                       )),
  description          text,
  acknowledged_at      timestamptz,
  acknowledged_by      uuid REFERENCES public.users(id),
  acknowledgment_note  text,
  reported_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_client_requests_business_open
  ON public.client_requests (business_id, acknowledged_at)
  WHERE acknowledged_at IS NULL;

CREATE INDEX idx_client_requests_client
  ON public.client_requests (business_id, client_id);

CREATE INDEX idx_client_requests_job
  ON public.client_requests (business_id, job_id)
  WHERE job_id IS NOT NULL;

ALTER TABLE public.client_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_requests_select ON public.client_requests FOR SELECT
USING (business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid()));

CREATE POLICY client_requests_insert ON public.client_requests FOR INSERT
WITH CHECK (business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid()));

CREATE POLICY client_requests_update ON public.client_requests FOR UPDATE
USING (business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid()))
WITH CHECK (business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE ON public.client_requests TO authenticated;
