-- Device-to-team assignment override (migration 080) needs visibility
-- into which resolution path the poller actually used each run: an
-- explicit team_device_assignments override, or the name-matching
-- fallback. Two counters on poll_geotab_runs, additive to
-- record_poll_geotab_run's signature (new trailing DEFAULT params, no
-- DROP needed -- return type is unchanged).
ALTER TABLE public.poll_geotab_runs
  ADD COLUMN device_assignment_resolved integer NOT NULL DEFAULT 0,
  ADD COLUMN device_name_matched        integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.record_poll_geotab_run(
  p_start_at                  timestamptz,
  p_end_at                    timestamptz,
  p_tenants_processed         integer,
  p_trips_processed           integer,
  p_matches                   integer,
  p_misses                    integer,
  p_errors                    text DEFAULT NULL,
  p_trigger                   text DEFAULT 'cron',
  p_jobs_newly_clocked        integer DEFAULT 0,
  p_jobs_skipped_existing     integer DEFAULT 0,
  p_jobs_divergent            integer DEFAULT 0,
  p_device_assignment_resolved integer DEFAULT 0,
  p_device_name_matched        integer DEFAULT 0
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.poll_geotab_runs
    (start_at, end_at, tenants_processed, trips_processed, matches, misses, errors,
     trigger, jobs_newly_clocked, jobs_skipped_existing, jobs_divergent,
     device_assignment_resolved, device_name_matched)
  VALUES
    (p_start_at, p_end_at, p_tenants_processed, p_trips_processed, p_matches, p_misses, p_errors,
     p_trigger, p_jobs_newly_clocked, p_jobs_skipped_existing, p_jobs_divergent,
     p_device_assignment_resolved, p_device_name_matched)
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION public.record_poll_geotab_run(timestamptz, timestamptz, integer, integer, integer, integer, text, text, integer, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_poll_geotab_run(timestamptz, timestamptz, integer, integer, integer, integer, text, text, integer, integer, integer, integer, integer) TO service_role;

-- ─── get_team_device_for_poll ────────────────────────────────────────
-- Real bug found while wiring the poller: get_team_device (migration
-- 080) is SECURITY INVOKER on purpose, so RLS is the tenant boundary
-- for the `authenticated` browser caller. But service_role in this
-- project has NO table grants by deliberate, established convention
-- (113 of 118 public tables -- see migration 072's own comment) --
-- there is no BYPASSRLS shortcut here like stock Supabase. Calling
-- get_team_device as service_role fails with a plain 42501 permission
-- error on team_device_assignments, not an RLS rejection, because
-- SECURITY INVOKER means it runs with the CALLER's privileges and
-- service_role was never granted SELECT on the table.
--
-- Fix: a SECURITY DEFINER, service_role-only twin for the poller,
-- mirroring get_team_device's exact query -- same pattern as every
-- other poll-geotab-clocks reader (list_active_geotab_integrations,
-- get_business_offices_for_polling). authenticated keeps using
-- get_team_device (RLS-backed); service_role uses this one.
CREATE OR REPLACE FUNCTION public.get_team_device_for_poll(
  p_business_id uuid,
  p_team_code   text,
  p_on_date     date
) RETURNS TABLE(device_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.device_id
  FROM public.team_device_assignments t
  WHERE t.business_id = p_business_id
    AND t.team_code    = p_team_code
    AND t.effective_from <= p_on_date
    AND COALESCE(t.effective_to, '9999-12-31'::date) >= p_on_date
    AND t.device_id IS DISTINCT FROM '__default__'
  ORDER BY t.effective_from DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_team_device_for_poll(uuid, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_team_device_for_poll(uuid, text, date) TO service_role;
