-- v11.0.2 Item B — Per-tenant phone provider integrations.
--
-- Today: send-sms Edge Function reads RingCentral credentials from
-- Supabase secrets (env vars). Single shared set of credentials for the
-- entire platform — fine when there's one tenant, broken when there's
-- two. Every additional tenant would have to share Manna Maids' RC
-- account.
--
-- New model: each tenant has its own integration row carrying its own
-- credentials and outbound phone number. Edge Function resolves the
-- caller's tenant from JWT → looks up the integration row → uses those
-- credentials. The env vars stay as a backfill source for the existing
-- Manna Maids tenant (one-time hydrate on first call).
--
-- Schema choices:
--   credentials jsonb        — flexible per-provider shape. For RC:
--                              {client_id, client_secret, refresh_token}.
--                              For Text Request: {api_key, account_id}.
--   UNIQUE(business_id, provider) — one integration per (tenant, provider).
--   status text              — 'active' | 'disconnected' | 'error' so the
--                              UI can show a connection indicator.
--   last_used_at / last_error — operational telemetry.
--
-- RLS: owners + admins only. Managers don't see credentials.

CREATE TABLE public.business_phone_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  phone_number_e164 text NOT NULL,
  credentials       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'active',
  last_used_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT business_phone_integrations_provider_chk
    CHECK (provider IN ('ringcentral','text_request','twilio')),
  CONSTRAINT business_phone_integrations_status_chk
    CHECK (status IN ('active','disconnected','error'))
);

-- One integration per (tenant, provider). Soft-deletes don't block re-add.
CREATE UNIQUE INDEX business_phone_integrations_active_uq
  ON public.business_phone_integrations (business_id, provider)
  WHERE deleted_at IS NULL;

CREATE INDEX business_phone_integrations_business_idx
  ON public.business_phone_integrations (business_id)
  WHERE deleted_at IS NULL;

ALTER TABLE public.business_phone_integrations ENABLE ROW LEVEL SECURITY;

-- SELECT: owners + admins of the tenant only. Managers and below can
-- send SMS via the Edge Function (which uses service_role internally),
-- but can't read the raw credentials from the table.
CREATE POLICY business_phone_integrations_select
ON public.business_phone_integrations FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin')
  )
);

CREATE POLICY business_phone_integrations_insert
ON public.business_phone_integrations FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin')
  )
);

CREATE POLICY business_phone_integrations_update
ON public.business_phone_integrations FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin')
  )
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin')
  )
);

CREATE POLICY business_phone_integrations_delete
ON public.business_phone_integrations FOR DELETE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
    AND u.role IN ('owner','admin')
  )
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_business_phone_integrations_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER business_phone_integrations_updated_at
  BEFORE UPDATE ON public.business_phone_integrations
  FOR EACH ROW EXECUTE FUNCTION public.touch_business_phone_integrations_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_phone_integrations TO authenticated;

-- ============================================================================
-- get_active_phone_integration(p_business_id, p_provider)
-- ============================================================================
-- SECURITY DEFINER lookup used by the send-sms Edge Function. The
-- function has service_role anyway, so bypassing RLS isn't a change in
-- privilege — but a stable definer function gives us one auditable
-- entry point that returns ONLY the fields the SMS path needs.
-- Returns null when no integration row exists (caller falls back to
-- env vars during the Manna Maids transition period).

CREATE OR REPLACE FUNCTION public.get_active_phone_integration(
  p_business_id uuid,
  p_provider    text DEFAULT 'ringcentral'
)
RETURNS TABLE (
  phone_number_e164 text,
  credentials       jsonb,
  status            text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT i.phone_number_e164, i.credentials, i.status
  FROM public.business_phone_integrations i
  WHERE i.business_id = p_business_id
    AND i.provider    = p_provider
    AND i.deleted_at IS NULL
    AND i.status     <> 'disconnected'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_active_phone_integration(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_phone_integration(uuid, text) TO authenticated, service_role;

-- ============================================================================
-- mark_phone_integration_used + mark_phone_integration_error
-- ============================================================================
-- Telemetry helpers the Edge Function calls after each send attempt. The
-- caller is service_role so these are SECURITY DEFINER for path-set
-- consistency rather than for privilege uplift.

CREATE OR REPLACE FUNCTION public.mark_phone_integration_used(
  p_business_id uuid,
  p_provider    text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.business_phone_integrations
  SET last_used_at = now(), last_error = NULL, status = 'active'
  WHERE business_id = p_business_id AND provider = p_provider AND deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.mark_phone_integration_error(
  p_business_id uuid,
  p_provider    text,
  p_error       text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.business_phone_integrations
  SET status = 'error', last_error = LEFT(p_error, 500)
  WHERE business_id = p_business_id AND provider = p_provider AND deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.mark_phone_integration_used(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_phone_integration_error(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_phone_integration_used(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_phone_integration_error(uuid, text, text) TO service_role;
