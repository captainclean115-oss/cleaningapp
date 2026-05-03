-- Migration 017: Teams Backfill Repair
-- Migration 016's DO $$ block failed silently in production.
-- This migration replays the backfill as plain SQL.
-- Manually executed via Supabase SQL editor on May 3, 2026.
-- Owner business: 48532f06-0625-415b-9091-2638bed6506d
-- Team 1 UUID: ad7a9991-b2ed-4d2b-9700-735697d74fc1
-- 47 employees assigned (including soft-deleted, for data hygiene)

INSERT INTO public.teams (business_id, name, color, display_order)
VALUES ('48532f06-0625-415b-9091-2638bed6506d', 'Team 1', '#3b82f6', 0)
ON CONFLICT (business_id, name) DO NOTHING;

UPDATE public.employees
SET team_id = (SELECT id FROM public.teams
               WHERE business_id = '48532f06-0625-415b-9091-2638bed6506d'
               AND name = 'Team 1' LIMIT 1)
WHERE business_id = '48532f06-0625-415b-9091-2638bed6506d'
  AND team_id IS NULL;
