-- Device-to-team assignment override, per-tenant, day-scoped.
--
-- Problem this solves: Geotab device names are hardcoded to physical
-- vehicles (device named "B1" = the B1 van). When Tom lends a vehicle
-- out or a team drives a different car (broken Geotab, borrowed car),
-- the existing device.name.toUpperCase().includes(teamCode) matching
-- (index.html, ~6 call sites, see PR history) silently attributes GPS
-- data to the wrong team, or finds nothing at all.
--
-- Verified against the LIVE Manna Geotab device list while building
-- this (real Authenticate + Get Device call, not assumed from code):
-- team B1 currently has ZERO matching device -- no device name in the
-- account contains "B1" as a substring. This is the concrete case that
-- motivated this feature, not a hypothetical.

CREATE TABLE public.team_device_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  team_code      text NOT NULL,
  device_id      text,  -- nullable: allows "no GPS today" assignment
  effective_from date NOT NULL,
  effective_to   date,  -- nullable: open-ended
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES public.users(id),
  UNIQUE (business_id, team_code, effective_from)
);

CREATE INDEX idx_tda_business_team   ON public.team_device_assignments(business_id, team_code, effective_from DESC);
CREATE INDEX idx_tda_business_device ON public.team_device_assignments(business_id, device_id) WHERE device_id IS NOT NULL;

ALTER TABLE public.team_device_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tda_select ON public.team_device_assignments FOR SELECT USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY tda_insert ON public.team_device_assignments FOR INSERT WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner','admin','manager')
);

CREATE POLICY tda_update ON public.team_device_assignments FOR UPDATE USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner','admin','manager')
);

GRANT SELECT, INSERT, UPDATE ON public.team_device_assignments TO authenticated;

-- ─── get_team_device ─────────────────────────────────────────────────
-- IMPORTANT SCOPE NOTE: this function implements step 1 ONLY (explicit
-- assignment lookup). Step 2 of the originally-specified 3-step
-- resolver -- "fall back to Geotab device name matching" -- cannot live
-- in SQL: there is no `devices` table, Geotab's device list only exists
-- as live API data fetched by whichever caller (browser or the
-- poll-geotab-clocks Edge Function) already holds an authenticated
-- Geotab session. A SQL function has no session to reuse and building
-- one here would mean a THIRD independent copy of Geotab session/auth
-- handling (after geotab-call and poll-geotab-clocks), which is exactly
-- the duplication PR #2's own header comment argued against.
--
-- So: this function returns the explicit assignment's device_id, or
-- NULL if none is set for that team+date. Callers are expected to treat
-- NULL as "no override -- fall back to your own existing name-matching
-- logic," which is unchanged and still lives where it always has (the
-- ~6 index.html call sites and poll-geotab-clocks). This function is
-- the piece that's genuinely new; the name-matching fallback already
-- existed and is being reused, not rebuilt.
--
-- SECURITY INVOKER, not DEFINER: RLS on team_device_assignments (above)
-- is the real tenant boundary for the `authenticated` caller (browser
-- Live Tracking, Team Management UI). service_role (poll-geotab-clocks)
-- has BYPASSRLS by Supabase default, so it can still resolve any
-- tenant's assignment when looping all tenants -- same pattern as every
-- other SECURITY INVOKER reader added this project (migration 071).
--
-- RETURNS TABLE, not a scalar text -- deliberate deviation from the
-- literal "returns device_id text (nullable)" spec. A scalar can't
-- distinguish "an explicit no-GPS assignment exists (device_id IS
-- NULL)" from "no assignment row exists at all" -- both collapse to
-- the same NULL, which would make the explicit no-GPS case silently
-- fall through to name-matching and defeat the whole point of that
-- nullable column. RETURNS TABLE preserves the distinction for free:
-- zero rows back = no assignment, fall back to name-matching; one row
-- back with device_id NULL = explicit no-GPS, stop there.
-- '__default__' sentinel: the Team Management UI writes this literal
-- value when Tom explicitly picks "Default (matches team name)" from
-- the dropdown, rather than a real device id. There's no DELETE policy
-- on this table (audit trail stays intact), so "go back to default"
-- can't be represented by removing today's row -- it's represented by
-- overwriting it with a value that this resolver treats as "no
-- assignment," via the IS DISTINCT FROM filter below. That makes it
-- behave EXACTLY like "no row exists" everywhere else (EF, browser) —
-- zero special-casing needed in any consumer.
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

-- authenticated only: service_role has no SELECT grant on
-- team_device_assignments (deliberate project convention, see
-- migration 081's get_team_device_for_poll comment for the DEFINER
-- twin the poller actually uses instead).
GRANT EXECUTE ON FUNCTION public.get_team_device(uuid, text, date) TO authenticated;

-- ─── Backfill: today's real name-matching state for Manna's 8 teams ──
-- Verified against the LIVE Geotab device list (Authenticate + Get
-- Device), not assumed -- these are the actual current device ids for
-- each team's name-matched vehicle as of the day this migration was
-- written. B1 is seeded with device_id = NULL: no device in the
-- account currently has a name containing "B1" at all, so today's
-- honest state for that team really is "no GPS coverage," and an
-- explicit NULL row documents that rather than leaving it silently
-- unassigned.
INSERT INTO public.team_device_assignments (business_id, team_code, device_id, effective_from, notes) VALUES
  ('48532f06-0625-415b-9091-2638bed6506d', 'B1', NULL,  CURRENT_DATE, 'Backfill: no Geotab device currently name-matches B1'),
  ('48532f06-0625-415b-9091-2638bed6506d', 'B3', 'bE',  CURRENT_DATE, 'Backfill: current name-match default'),
  ('48532f06-0625-415b-9091-2638bed6506d', 'B5', 'b10', CURRENT_DATE, 'Backfill: current name-match default'),
  ('48532f06-0625-415b-9091-2638bed6506d', 'S1', 'bB',  CURRENT_DATE, 'Backfill: current name-match default'),
  ('48532f06-0625-415b-9091-2638bed6506d', 'S3', 'b12', CURRENT_DATE, 'Backfill: current name-match default'),
  ('48532f06-0625-415b-9091-2638bed6506d', 'M1', 'b10B',CURRENT_DATE, 'Backfill: current name-match default'),
  ('48532f06-0625-415b-9091-2638bed6506d', 'M2', 'b13', CURRENT_DATE, 'Backfill: current name-match default'),
  ('48532f06-0625-415b-9091-2638bed6506d', 'M3', 'b10E',CURRENT_DATE, 'Backfill: current name-match default');
