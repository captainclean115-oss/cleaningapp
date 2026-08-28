-- PR #150: teach get_team_device to distinguish a date-scoped override
-- (effective_to IS NOT NULL, e.g. a one-day vehicle swap) from a team's
-- standing default (effective_to IS NULL, open-ended). The browser-side
-- PR #123 mismatch banner needs this to stop firing on days with a
-- deliberate daily swap in effect -- swapping B1 onto S3's van makes the
-- resolved device's live Geotab name NOT contain "B1" on purpose, which
-- previously looked identical to the real bug PR #123 was built to catch
-- (a team's PERMANENT assignment silently drifting from its live device
-- name, e.g. the M1/M3 rename incident). The warning stays fully live for
-- that permanent case; it's suppressed only when a temporary override is
-- what's actually resolving.
--
-- CREATE OR REPLACE cannot change a function's return type, so the old
-- single-column-return signature must be dropped first.

DROP FUNCTION IF EXISTS public.get_team_device(uuid, text, date);

CREATE FUNCTION public.get_team_device(
  p_business_id uuid,
  p_team_code   text,
  p_on_date     date
) RETURNS TABLE(device_id text, is_override boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT t.device_id, (t.effective_to IS NOT NULL) AS is_override
  FROM public.team_device_assignments t
  WHERE t.business_id = p_business_id
    AND t.team_code    = p_team_code
    AND t.effective_from <= p_on_date
    AND COALESCE(t.effective_to, '9999-12-31'::date) >= p_on_date
    AND t.device_id IS DISTINCT FROM '__default__'
  ORDER BY t.effective_from DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_device(uuid, text, date) TO authenticated;
