-- PR #115 — per-stop manager overrides for GPS lunch-break detection.
--
-- _detectDayLunch (PR #114) auto-flags a GPS stop as a possible lunch
-- break using heuristics (short unmatched stop, not at depot). Those
-- heuristics are sometimes wrong -- a 3-minute stop might be a real
-- quick errand, not lunch. This table lets a manager correct one
-- specific stop's classification, with the correction feeding back
-- into every surface that reads lunch data (weekly Hours Report card,
-- hours calculation, Today's Activity flags, employee portal), all of
-- which already read from a single computation
-- (_detectDayLunch/weekHours[team].lunch) per PR #114 -- so fixing that
-- one function to consult this table fixes every surface at once.
--
-- Scoped by TEAM, not employee: GPS stops are recorded per-vehicle
-- (one team's vehicle), not per-individual crew member -- the existing
-- lunch-detection/hours-calculation pipeline this overrides is already
-- entirely team-scoped (weekHours[team], not weekHours[employeeId]).
-- An employee_id column would imply a distinction the underlying GPS
-- data can't actually support (which specific crew member on a
-- multi-person team "had" the flagged stop) and would require
-- reconciling against whichever employee happens to be displayed under
-- that team for that day -- team+date+stop_key is the natural key that
-- matches how the data is actually produced and consumed everywhere
-- else in this feature area.
--
-- stop_key is the stop's own GPS arrival timestamp (ISO string, from
-- the Geotab trip's .stop field) -- confirmed via a full-file grep that
-- nothing in this codebase has ever relied on a Geotab-assigned trip
-- .id existing or being stable (Geotab's Trip API is known not to
-- reliably return several fields; only .start/.stop/.stopAddress/
-- .stopPoint/.distance are ever read). The arrival timestamp is
-- already the field this whole feature area uses for stop identity/
-- ordering/dedup (t.stop, lt.stop, a.stop throughout PR #109-114), and
-- is stable across re-fetches since Geotab trip history is immutable
-- once recorded.
CREATE TABLE public.lunch_flag_overrides (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  team               text NOT NULL,
  date               date NOT NULL,
  stop_key           text NOT NULL,
  override_type      text NOT NULL CHECK (override_type IN ('exclude', 'include')),
  -- Denormalized for display/audit convenience -- avoids needing to
  -- re-fetch live Geotab data just to show "what stop was this" in the
  -- Activity Log or an admin listing.
  stop_address       text,
  stop_duration_min  integer,
  created_by         uuid REFERENCES public.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, team, date, stop_key)
);

CREATE INDEX idx_lunch_flag_overrides_business_team_date
  ON public.lunch_flag_overrides(business_id, team, date);

ALTER TABLE public.lunch_flag_overrides ENABLE ROW LEVEL SECURITY;

-- Mirrors team_device_assignments (migration 080), the most recent
-- precedent for a small team-scoped table written directly by the
-- authenticated client (not service-role/Edge-Function-only, per this
-- project's established "service_role has no table grants" convention
-- -- see migration 080's own comment on that). owner/admin/manager only
-- (no dispatcher): this affects payroll-facing hours numbers, a
-- narrower bar than daily_assignments' scheduling-only role set.
CREATE POLICY lunch_flag_overrides_select ON public.lunch_flag_overrides FOR SELECT USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY lunch_flag_overrides_insert ON public.lunch_flag_overrides FOR INSERT WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
);

CREATE POLICY lunch_flag_overrides_update ON public.lunch_flag_overrides FOR UPDATE USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
) WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
);

CREATE POLICY lunch_flag_overrides_delete ON public.lunch_flag_overrides FOR DELETE USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lunch_flag_overrides TO authenticated;
