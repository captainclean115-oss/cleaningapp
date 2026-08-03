-- Fix: GPS Vehicle dropdown "reverts to old assignment" after saving
-- "Default" on a later date than an earlier explicit-device row.
--
-- Root cause (found by reproducing live): get_team_device /
-- get_team_device_for_poll filtered OUT '__default__' rows BEFORE
-- ranking by effective_from DESC:
--
--   WHERE ... AND device_id IS DISTINCT FROM '__default__'
--   ORDER BY effective_from DESC LIMIT 1
--
-- When the MOST RECENT row for a team is a '__default__' sentinel
-- (Tom picked "Default" in the UI), that row was invisible to the
-- ranking entirely, so an OLDER row with a real device_id -- meant to
-- be superseded -- won instead. Reproduced exactly against live data:
-- team M1 had a 2026-07-29 backfill row (device_id='b10B') and a
-- 2026-08-03 row (device_id='__default__') from Tom re-saving as
-- Default after renaming Geotab devices. The old query returned 'b10B'
-- (wrong -- the stale assignment); the correct answer is "no override,
-- fall back to name-matching" (empty result).
--
-- This was NOT the same bug class as the employee-save fix (migration
-- committed separately) -- the write path was correct and the save DID
-- persist. The bug was entirely in the read/resolve side: ranking
-- picked the wrong row once real history existed, something the
-- original single-row-at-a-time tests during PR #57/#58 never
-- exercised (each test used a fresh row, never a real "supersede an
-- older row on a new day" sequence).
--
-- Fix: rank ALL rows (including '__default__') for the date range
-- FIRST, take the single most recent one, and only THEN check whether
-- it's the sentinel. A CTE with LIMIT 1 inside it, then a WHERE filter
-- on the CTE's single row, keeps this in LANGUAGE sql (no need for
-- plpgsql branching) while getting the ordering right.

CREATE OR REPLACE FUNCTION public.get_team_device(
  p_business_id uuid,
  p_team_code   text,
  p_on_date     date
) RETURNS TABLE(device_id text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH latest AS (
    SELECT t.device_id
    FROM public.team_device_assignments t
    WHERE t.business_id = p_business_id
      AND t.team_code    = p_team_code
      AND t.effective_from <= p_on_date
      AND COALESCE(t.effective_to, '9999-12-31'::date) >= p_on_date
    ORDER BY t.effective_from DESC
    LIMIT 1
  )
  SELECT l.device_id FROM latest l WHERE l.device_id IS DISTINCT FROM '__default__';
$$;

-- Also closes a small, separate gap found while re-verifying grants
-- after this CREATE OR REPLACE: get_team_device never had an explicit
-- REVOKE ALL FROM PUBLIC (migration 080 granted authenticated/
-- service_role but never revoked the default PUBLIC EXECUTE every new
-- function gets), unlike every other function in this project. RLS on
-- team_device_assignments already blocks anon in practice (auth.uid()
-- is null, business_id = null never matches), so this wasn't
-- exploitable, but it's inconsistent with the established
-- revoke-then-grant pattern everywhere else -- tidied up while here.
REVOKE ALL ON FUNCTION public.get_team_device(uuid, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_team_device(uuid, text, date) TO authenticated;

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
  WITH latest AS (
    SELECT t.device_id
    FROM public.team_device_assignments t
    WHERE t.business_id = p_business_id
      AND t.team_code    = p_team_code
      AND t.effective_from <= p_on_date
      AND COALESCE(t.effective_to, '9999-12-31'::date) >= p_on_date
    ORDER BY t.effective_from DESC
    LIMIT 1
  )
  SELECT l.device_id FROM latest l WHERE l.device_id IS DISTINCT FROM '__default__';
$$;
