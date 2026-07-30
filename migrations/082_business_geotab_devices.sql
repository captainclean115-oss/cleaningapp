-- Full Geotab device visibility + editable nicknames + tenant-wide hide.
--
-- business_geotab_devices: one row per Geotab device this tenant has
-- ever seen (populated automatically by the poller, migration 081's
-- poll-geotab-clocks, on every Get Device fetch -- not user-created).
-- Not the source of truth for a device's live name/status -- that's
-- always fetched fresh from Geotab. This table only carries what
-- Geotab itself doesn't: our own display_name override, the hidden
-- flag, and when we've last actually seen the device reporting.
CREATE TABLE public.business_geotab_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  geotab_device_id text NOT NULL,
  display_name    text,
  hidden          boolean NOT NULL DEFAULT false,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, geotab_device_id)
);

CREATE INDEX idx_bgd_business ON public.business_geotab_devices(business_id);

ALTER TABLE public.business_geotab_devices ENABLE ROW LEVEL SECURITY;

-- Read-only to tenants -- any authenticated tenant member (Live
-- Tracking is used by more than managers). Writes are RPC-only
-- (rename_geotab_device / set_geotab_device_hidden below, plus the
-- poller's upsert_geotab_device_seen), so there is deliberately no
-- INSERT/UPDATE policy here.
CREATE POLICY bgd_select ON public.business_geotab_devices FOR SELECT USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

GRANT SELECT ON public.business_geotab_devices TO authenticated;

-- device_name_history: insert-only audit trail for renames. Never
-- updated or deleted -- a full record of who renamed what and when
-- matters more here than tidiness. Manager-tier SELECT only (audit
-- data), written exclusively by rename_geotab_device (SECURITY
-- DEFINER, does its own manager-tier check -- see below), so again no
-- INSERT/UPDATE/DELETE policy.
CREATE TABLE public.device_name_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  geotab_device_id text NOT NULL,
  old_name         text,
  new_name         text NOT NULL,
  changed_by       uuid REFERENCES public.users(id),
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason           text
);

CREATE INDEX idx_dnh_business_device ON public.device_name_history(business_id, geotab_device_id, changed_at DESC);

ALTER TABLE public.device_name_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY dnh_select ON public.device_name_history FOR SELECT USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner','admin','manager')
);

GRANT SELECT ON public.device_name_history TO authenticated;

-- ─── upsert_geotab_device_seen ───────────────────────────────────────
-- Called by poll-geotab-clocks (service_role) once per device on every
-- Get Device fetch. business_id is the poller's own loop variable, not
-- user input, so no cross-tenant check needed here -- same trust level
-- as list_active_geotab_integrations / get_business_offices_for_polling.
CREATE OR REPLACE FUNCTION public.upsert_geotab_device_seen(
  p_business_id      uuid,
  p_geotab_device_id text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.business_geotab_devices (business_id, geotab_device_id, first_seen_at, last_seen_at)
  VALUES (p_business_id, p_geotab_device_id, now(), now())
  ON CONFLICT (business_id, geotab_device_id)
  DO UPDATE SET last_seen_at = now();
$$;

REVOKE ALL ON FUNCTION public.upsert_geotab_device_seen(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_geotab_device_seen(uuid, text) TO service_role;

-- ─── rename_geotab_device ────────────────────────────────────────────
-- Browser-facing, so p_business_id is attacker-controlled input, not
-- an internal loop variable -- this function resolves the CALLER's own
-- business_id/role from users and compares against p_business_id
-- rather than trusting it directly (the exact tenant-hole pattern
-- flagged repeatedly this project; see set_job_actual_time, migration
-- 032, for the precedent this mirrors).
CREATE OR REPLACE FUNCTION public.rename_geotab_device(
  p_business_id      uuid,
  p_geotab_device_id text,
  p_new_name         text,
  p_reason           text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_user_id uuid;
  v_caller_biz     uuid;
  v_caller_role    text;
  v_old_name       text;
BEGIN
  SELECT u.id, u.business_id, u.role
  INTO v_caller_user_id, v_caller_biz, v_caller_role
  FROM public.users u
  WHERE u.auth_user_id = auth.uid();

  IF v_caller_biz IS NULL OR v_caller_biz <> p_business_id THEN
    RAISE EXCEPTION 'Cross-business operation blocked';
  END IF;
  IF v_caller_role NOT IN ('owner','admin','manager') THEN
    RAISE EXCEPTION 'Only owners, admins, and managers can rename devices';
  END IF;
  IF p_new_name IS NULL OR trim(p_new_name) = '' THEN
    RAISE EXCEPTION 'New name cannot be empty';
  END IF;

  SELECT display_name INTO v_old_name
  FROM public.business_geotab_devices
  WHERE business_id = p_business_id AND geotab_device_id = p_geotab_device_id;

  INSERT INTO public.business_geotab_devices (business_id, geotab_device_id, display_name)
  VALUES (p_business_id, p_geotab_device_id, trim(p_new_name))
  ON CONFLICT (business_id, geotab_device_id)
  DO UPDATE SET display_name = trim(p_new_name);

  INSERT INTO public.device_name_history (business_id, geotab_device_id, old_name, new_name, changed_by, reason)
  VALUES (p_business_id, p_geotab_device_id, v_old_name, trim(p_new_name), v_caller_user_id, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.rename_geotab_device(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rename_geotab_device(uuid, text, text, text) TO authenticated;

-- ─── set_geotab_device_hidden ────────────────────────────────────────
-- Same caller-verification pattern as rename_geotab_device.
CREATE OR REPLACE FUNCTION public.set_geotab_device_hidden(
  p_business_id      uuid,
  p_geotab_device_id text,
  p_hidden           boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_biz  uuid;
  v_caller_role text;
BEGIN
  SELECT u.business_id, u.role
  INTO v_caller_biz, v_caller_role
  FROM public.users u
  WHERE u.auth_user_id = auth.uid();

  IF v_caller_biz IS NULL OR v_caller_biz <> p_business_id THEN
    RAISE EXCEPTION 'Cross-business operation blocked';
  END IF;
  IF v_caller_role NOT IN ('owner','admin','manager') THEN
    RAISE EXCEPTION 'Only owners, admins, and managers can hide/unhide devices';
  END IF;

  INSERT INTO public.business_geotab_devices (business_id, geotab_device_id, hidden)
  VALUES (p_business_id, p_geotab_device_id, p_hidden)
  ON CONFLICT (business_id, geotab_device_id)
  DO UPDATE SET hidden = p_hidden;
END;
$$;

REVOKE ALL ON FUNCTION public.set_geotab_device_hidden(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_geotab_device_hidden(uuid, text, boolean) TO authenticated;
