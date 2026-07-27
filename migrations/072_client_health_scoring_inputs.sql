-- Fix: score-client-health returned 500 "Failed to load business" on every
-- run (Tom, 2026-07-27, via the Rescore button).
--
-- ─── Root cause ────────────────────────────────────────────────────
--
-- `service_role` on this project has NO data-plane privileges on almost
-- every public table. Checked across all 118 public tables:
--
--   service_role=Dxtm/postgres   -> 113 tables (TRUNCATE, REFERENCES,
--                                   TRIGGER, MAINTAIN — but NOT
--                                   SELECT/INSERT/UPDATE/DELETE)
--   service_role=arwdDxtm        ->   5 tables: users, employees,
--                                   employee_invites, employee_sessions,
--                                   job_applications
--
-- Those 5 are exactly what accept-invite / set-employee-password need.
-- This is deliberate, not an oversight: service_role bypasses RLS, so
-- withholding table grants keeps the blast radius of a leaked service
-- key small, and every Edge Function reaches data through SECURITY
-- DEFINER RPCs instead. rc-inbox, send-sms and geotab-call all follow
-- it — they touch `users` (granted) plus DEFINER RPCs, nothing else.
--
-- score-client-health broke the convention: it read businesses, clients
-- and jobs directly off the service-role client. The `users` lookup
-- succeeded (granted), so businessId resolved and the function got as
-- far as the businesses SELECT, which failed with
-- `42501 permission denied for table businesses`. The EF surfaced that
-- as "Failed to load business", which read like a missing row and sent
-- the first diagnosis at the data rather than the grant.
--
-- ─── Fix ───────────────────────────────────────────────────────────
--
-- Three SECURITY DEFINER readers, service_role only, mirroring
-- get_geotab_session / get_active_phone_integration. Granting
-- service_role SELECT on the three tables would also work in one line,
-- but it would contradict a deliberate posture and leave this EF as the
-- only one with direct table access.
--
-- These are service_role-only on purpose. The browser never calls them:
-- it reads scores through get_latest_client_health / count_at_risk_clients
-- / get_client_health_drops, which are SECURITY INVOKER precisely so RLS
-- stays the tenant boundary for user-facing reads (migration 071).
--
-- Tenant safety is unchanged: in user-JWT mode the EF derives
-- p_business_id from the caller's own users row, so it can only ever ask
-- for its own tenant.

-- Config: businesses.business_settings->'client_health'.
-- Returns NULL when the tenant has no config yet; the EF falls back to
-- its own defaults, so a missing key is not an error.
CREATE OR REPLACE FUNCTION public.get_client_health_config(
  p_business_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.business_settings -> 'client_health'
  FROM   public.businesses b
  WHERE  b.id = p_business_id
    AND  b.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.get_client_health_config(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_client_health_config(uuid) TO service_role;

-- The scored set. status='active' AND deleted_at IS NULL — NOT
-- clients.active, which is vestigial and reads true for all 346 rows
-- including the 15 that are status='inactive'.
--
-- frequency is the frequency_code enum; cast to text so the EF can map
-- it without needing the enum type.
CREATE OR REPLACE FUNCTION public.list_active_clients_for_scoring(
  p_business_id uuid
)
RETURNS TABLE(
  id                uuid,
  external_id       text,
  first_name        text,
  last_name         text,
  phone             text,
  additional_phones text[],
  frequency         text,
  frequency_days    integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.external_id, c.first_name, c.last_name,
         c.phone, c.additional_phones, c.frequency::text, c.frequency_days
  FROM   public.clients c
  WHERE  c.business_id = p_business_id
    AND  c.status      = 'active'
    AND  c.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.list_active_clients_for_scoring(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_active_clients_for_scoring(uuid) TO service_role;

-- Jobs from p_since forward, including future-dated rows — the scorer
-- needs history for cadence/revenue AND the forward calendar for
-- forward_booking, so this deliberately does not cap at today.
--
-- jobs.client_id is TEXT and joins clients.external_id, not clients.id.
CREATE OR REPLACE FUNCTION public.list_jobs_for_scoring(
  p_business_id uuid,
  p_since       date
)
RETURNS TABLE(
  client_id text,
  date      date,
  price     numeric,
  status    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT j.client_id, j.date, j.price, j.status
  FROM   public.jobs j
  WHERE  j.business_id = p_business_id
    AND  j.date >= p_since;
$$;

REVOKE ALL ON FUNCTION public.list_jobs_for_scoring(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_jobs_for_scoring(uuid, date) TO service_role;
