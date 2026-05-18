-- Fix the cascade-lockout bug in PR2 of Geotab strategy.
--
-- The original mig 067 definition filtered `WHERE i.status = 'active'`.
-- Combined with the EF's `mark_geotab_integration_error` on any auth
-- failure, this turned ONE transient Geotab failure (e.g. Geotab's
-- "10 Authenticate calls per minute" rate limit being briefly tripped
-- by a thundering-herd from cold-start Edge Function instances) into
-- a CASCADE: status flips to 'error' → RPC returns no rows → every
-- subsequent geotab-call returns 424 "No active integration" until
-- someone manually re-saves the credentials.
--
-- Logs confirmed the pattern: ~10 successful 200s, then a 401 (Geotab
-- 401 "API calls quota exceeded. Maximum admitted 10 per 1m."),
-- then a cascade of 424s. business_geotab_integrations row stuck at
-- status='error' even though the credentials are perfectly valid.
--
-- Fix: drop the `status = 'active'` filter. Status is still set
-- by mark_geotab_integration_error / mark_geotab_integration_used for
-- observability (admin UI surfaces it as the health dot), but a
-- transient blip no longer hides the row from subsequent calls — the
-- EF will retry, succeed once Geotab cools off (next minute), and
-- mark_used will flip status back to 'active'. The system self-heals.
--
-- Also resets the existing Manna row to status='active' so Tom is
-- unblocked the moment this migration applies. Without this reset
-- he'd need to re-save credentials in Admin → Fleet Tracking to
-- clear the error state. The credentials are still valid; only the
-- bookkeeping field was stale.

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
    ORDER  BY i.updated_at DESC
    LIMIT  1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_active_geotab_integration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_geotab_integration(uuid) TO service_role;

-- Reset rows currently parked in status='error' from the cascade bug.
-- They have valid credentials; only the status was stale.
UPDATE public.business_geotab_integrations
SET    status     = 'active',
       last_error = NULL,
       updated_at = now()
WHERE  deleted_at IS NULL
  AND  status     = 'error';
