-- Migration 016: Teams table for proper team management
-- Sprint: 6.9
-- Purpose: Replace hardcoded team:"B1" string everywhere with real team records.
--          Add public.teams (business-scoped) + employees.team_id FK.
--          Backfill one default team per business and assign existing employees.
-- Apply: paste into Supabase SQL editor and run. Idempotent (re-runnable).

-- ============================================================
-- 1) teams table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#3b82f6',
  notes TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, name)
);

-- ============================================================
-- 2) employees.team_id FK (nullable for migration safety)
-- ============================================================
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL;

-- ============================================================
-- 3) Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_employees_team_id ON public.employees(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_business_id ON public.teams(business_id);

-- ============================================================
-- 4) RLS: managers/owners CRUD their own business's teams
-- ============================================================
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers_view_own_business_teams" ON public.teams;
CREATE POLICY "managers_view_own_business_teams" ON public.teams
  FOR SELECT USING (
    business_id IN (
      SELECT business_id FROM public.business_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

DROP POLICY IF EXISTS "managers_insert_own_business_teams" ON public.teams;
CREATE POLICY "managers_insert_own_business_teams" ON public.teams
  FOR INSERT WITH CHECK (
    business_id IN (
      SELECT business_id FROM public.business_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

DROP POLICY IF EXISTS "managers_update_own_business_teams" ON public.teams;
CREATE POLICY "managers_update_own_business_teams" ON public.teams
  FOR UPDATE USING (
    business_id IN (
      SELECT business_id FROM public.business_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

DROP POLICY IF EXISTS "managers_delete_own_business_teams" ON public.teams;
CREATE POLICY "managers_delete_own_business_teams" ON public.teams
  FOR DELETE USING (
    business_id IN (
      SELECT business_id FROM public.business_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'manager')
    )
  );

-- ============================================================
-- 5) Backfill: create "Team 1" per business, assign existing employees
-- ============================================================
DO $$
DECLARE
  biz RECORD;
  default_team_id UUID;
BEGIN
  FOR biz IN SELECT DISTINCT business_id FROM public.employees WHERE business_id IS NOT NULL LOOP
    INSERT INTO public.teams (business_id, name, display_order)
    VALUES (biz.business_id, 'Team 1', 0)
    ON CONFLICT (business_id, name) DO NOTHING
    RETURNING id INTO default_team_id;

    IF default_team_id IS NULL THEN
      SELECT id INTO default_team_id FROM public.teams
      WHERE business_id = biz.business_id AND name = 'Team 1' LIMIT 1;
    END IF;

    UPDATE public.employees
    SET team_id = default_team_id
    WHERE business_id = biz.business_id AND team_id IS NULL;
  END LOOP;
END $$;

-- ============================================================
-- Verification (run manually after apply)
-- ============================================================
-- SELECT COUNT(*) AS team_count FROM public.teams;
-- SELECT COUNT(*) AS unassigned FROM public.employees WHERE team_id IS NULL;
-- SELECT b.id, b.name, COUNT(t.id) AS teams, COUNT(e.id) AS employees
--   FROM public.businesses b
--   LEFT JOIN public.teams t ON t.business_id = b.id
--   LEFT JOIN public.employees e ON e.business_id = b.id
--   GROUP BY b.id, b.name;
