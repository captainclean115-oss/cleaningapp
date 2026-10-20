-- Payroll cost tally + employee estimated pay (PR: payroll-cost-and-rates),
-- part 2: per-day rate/gross snapshot on published_employee_hours.
--
-- "A raise only affects days published after the change" falls out of
-- this for free: est_rate/est_gross are written ONCE, at publish time,
-- from whatever employees.pay_rate was AT THAT MOMENT -- never
-- recomputed retroactively. Re-publishing a week deliberately (the
-- existing "Publish now" button on the Hours tab already does a full
-- diff-and-republish; est_rate/est_gross are now part of that diff, so a
-- pure rate change with no hours change still triggers a rewrite --
-- no separate "Republish week" button needed, see the PR description).
--
-- est_gross is an INTEGER number of CENTS, not a numeric dollar amount --
-- this project's money-math rule ("money math in cents, rounded once
-- per employee-day, no floating-point drift") applies to what's STORED,
-- not just what's computed in memory.
ALTER TABLE public.published_employee_hours
  ADD COLUMN IF NOT EXISTS est_rate  numeric(8,2),
  ADD COLUMN IF NOT EXISTS est_gross integer;

COMMENT ON COLUMN public.published_employee_hours.est_rate IS
  'Hourly rate (dollars) used to compute est_gross for this one day, snapshotted from employees.pay_rate at the moment this row was published. NULL when the employee had no pay_rate on file at publish time -- never defaulted to 0, and never recomputed when pay_rate changes later (re-publish the week on purpose to pick up a new rate).';
COMMENT ON COLUMN public.published_employee_hours.est_gross IS
  'Computed gross pay for this one day, in CENTS (integer -- this project''s money-math rule, never a float). hours * est_rate, plus 1.5x for any portion over 40 cumulative hours in the SAME Mon-Fri view when the business''s overtime_enabled setting is on (see migration 117''s own OVERTIME SCOPE note for why this is Mon-Fri, not a true Monday-Sunday pay week). NULL whenever est_rate is NULL, or the day''s status is not ''worked'' (off/vacation/salaried/not_published) -- never a fake $0.';

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (not applied -- run this block to undo the above)
-- ═══════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.published_employee_hours DROP COLUMN IF EXISTS est_rate;
-- ALTER TABLE public.published_employee_hours DROP COLUMN IF EXISTS est_gross;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run after applying)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='published_employee_hours'
-- AND column_name IN ('est_rate','est_gross');
--
-- No RLS change needed here -- est_rate/est_gross ride the EXISTING
-- published_employee_hours_select policy (migration 115), which already
-- restricts an employee to her own rows only. Re-confirm that's still
-- true after this migration:
-- SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.published_employee_hours'::regclass;
