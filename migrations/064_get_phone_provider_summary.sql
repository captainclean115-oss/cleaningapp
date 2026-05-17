-- PR2 of SMS strategy: the browser needs to know which provider+auth_method
-- the current tenant is on so it can route SMS sends correctly:
--   - provider=native_sms      → open sms: URI in browser
--   - provider=ringcentral     → invoke send-sms Edge Function
--   - auth_method=oauth        → keep legacy browser OAuth refresh code alive
--   - auth_method=jwt          → browser OAuth path is dead; hide Connect UI
--
-- business_phone_integrations RLS gates SELECT to owners + admins only
-- because the row carries credentials. But this routing decision needs
-- to be readable by EVERY user in the tenant (employees too — the
-- on-my-way button is on employee surfaces). Solution: SECURITY DEFINER
-- RPC that returns just the routing-relevant columns, never credentials.
--
-- Always returns at most 1 row (active, non-deleted, lexically first).

CREATE OR REPLACE FUNCTION public.get_phone_provider_summary(
  p_business_id uuid
)
RETURNS TABLE(
  provider          text,
  phone_number_e164 text,
  status            text,
  auth_method       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.auth_belongs_to_business(p_business_id) THEN
    RAISE EXCEPTION 'not authorized for business_id %', p_business_id;
  END IF;
  RETURN QUERY
    SELECT bpi.provider,
           bpi.phone_number_e164,
           bpi.status,
           COALESCE(bpi.credentials->>'auth_method', 'oauth')::text AS auth_method
    FROM public.business_phone_integrations bpi
    WHERE bpi.business_id = p_business_id
      AND bpi.deleted_at IS NULL
      AND bpi.status     = 'active'
    ORDER BY bpi.updated_at DESC
    LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_phone_provider_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_phone_provider_summary(uuid) TO authenticated;
