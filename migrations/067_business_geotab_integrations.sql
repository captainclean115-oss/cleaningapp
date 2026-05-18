-- Per-tenant Geotab integration table. Mirrors business_phone_integrations
-- shape; replaces the hardcoded GEOTAB_USER/GEOTAB_PASS/GEOTAB_DB
-- constants in index.html (lines 27401-27404, scheduled for retirement
-- in PR2).
--
-- PR1: server-side capability only. Manna's hardcoded path keeps working
-- in the browser as a fallback while we test the EF-driven path. PR2
-- rewires all `geotabCall(...)` sites through a new geotab-call Edge
-- Function and drops the constants + the in-browser auth flow.
--
-- One active row per tenant. Geotab credentials are tenant-wide (a
-- single MyGeotab account per cleaning business), not per-user.

CREATE TABLE IF NOT EXISTS public.business_geotab_integrations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  server       text NOT NULL DEFAULT 'my.geotab.com',
  database     text NOT NULL,
  username     text NOT NULL,
  password     text NOT NULL,
  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'disconnected', 'error')),
  last_used_at timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS business_geotab_integrations_one_per_business
  ON public.business_geotab_integrations (business_id)
  WHERE deleted_at IS NULL;

ALTER TABLE public.business_geotab_integrations ENABLE ROW LEVEL SECURITY;

-- RLS: owner+admin only for SELECT/INSERT/UPDATE/DELETE. Credentials
-- (including password) sit in this table; only the EF's service-role
-- path is the canonical reader for those, but the Admin UI also needs
-- direct access to seed + edit the row.
CREATE POLICY business_geotab_integrations_select
  ON public.business_geotab_integrations FOR SELECT
  USING (
    public.auth_belongs_to_business(business_id) AND
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin')
    )
  );

CREATE POLICY business_geotab_integrations_insert
  ON public.business_geotab_integrations FOR INSERT
  WITH CHECK (
    public.auth_belongs_to_business(business_id) AND
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin')
    )
  );

CREATE POLICY business_geotab_integrations_update
  ON public.business_geotab_integrations FOR UPDATE
  USING (
    public.auth_belongs_to_business(business_id) AND
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin')
    )
  );

CREATE POLICY business_geotab_integrations_delete
  ON public.business_geotab_integrations FOR DELETE
  USING (
    public.auth_belongs_to_business(business_id) AND
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin')
    )
  );

-- ─── RPCs ──────────────────────────────────────────────────────────

-- Service-role only. Returns full credentials (including password) so
-- the geotab-call Edge Function can authenticate against Geotab. Never
-- exposed to authenticated/anon.
CREATE OR REPLACE FUNCTION public.get_active_geotab_integration(
  p_business_id uuid
)
RETURNS TABLE(
  id           uuid,
  server       text,
  database     text,
  username     text,
  password     text,
  status       text,
  last_used_at timestamptz,
  last_error   text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT i.id, i.server, i.database, i.username, i.password,
           i.status, i.last_used_at, i.last_error
    FROM   public.business_geotab_integrations i
    WHERE  i.business_id = p_business_id
      AND  i.deleted_at IS NULL
      AND  i.status     = 'active'
    LIMIT  1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_active_geotab_integration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_geotab_integration(uuid) TO service_role;

-- Authenticated-role: routing/status info WITHOUT credentials. Lets a
-- non-admin tenant member render "configured / not configured" UI
-- without seeing the password. Mirrors get_phone_provider_summary
-- (mig 064).
CREATE OR REPLACE FUNCTION public.get_geotab_summary(
  p_business_id uuid
)
RETURNS TABLE(
  configured   boolean,
  server       text,
  database     text,
  status       text,
  last_used_at timestamptz,
  last_error   text
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
    SELECT TRUE AS configured,
           i.server, i.database, i.status, i.last_used_at, i.last_error
    FROM   public.business_geotab_integrations i
    WHERE  i.business_id = p_business_id
      AND  i.deleted_at IS NULL
      AND  i.status     = 'active'
    LIMIT  1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_geotab_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_geotab_summary(uuid) TO authenticated;

-- Service-role writes for the EF to update status after each call.
CREATE OR REPLACE FUNCTION public.mark_geotab_integration_used(
  p_business_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.business_geotab_integrations
  SET    last_used_at = now(),
         status       = 'active',
         last_error   = NULL,
         updated_at   = now()
  WHERE  business_id  = p_business_id
    AND  deleted_at   IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_geotab_integration_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_geotab_integration_used(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_geotab_integration_error(
  p_business_id uuid,
  p_error       text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.business_geotab_integrations
  SET    status     = 'error',
         last_error = LEFT(p_error, 500),
         updated_at = now()
  WHERE  business_id = p_business_id
    AND  deleted_at  IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_geotab_integration_error(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_geotab_integration_error(uuid, text) TO service_role;
