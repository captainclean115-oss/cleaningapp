-- Migration 114: Salary amount + period for salaried employees.
--
-- Follow-up to migration 113 (work_type) and the Salaried Admin/Office
-- no-hours work (PR #195, reused the pre-existing pay_type column).
-- Those shipped the *label* (pay_type = 'salary' => no hours tracked)
-- but gave Tom nowhere to actually record WHAT the salary is. This
-- migration adds exactly that: a dollar amount and the period it's
-- quoted in. Deliberately NOT normalized into an hourly-equivalent --
-- the whole point is that this number must never feed hourly math.
--
-- No backfill: every existing employee keeps salary_amount/
-- salary_period = NULL until Tom enters a real value from the Staff
-- screen himself. IF NOT EXISTS so this is safely re-runnable.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS salary_amount numeric(12,2) NULL,
  ADD COLUMN IF NOT EXISTS salary_period text NULL
    CHECK (salary_period IN ('year', 'month', 'week'));

COMMENT ON COLUMN public.employees.salary_amount IS
  'Dollar amount for a salaried employee (pay_type=''salary''), quoted in salary_period''s unit. NEVER used in hourly math (labor cost, job profit, payroll hours totals, GPS hours, Claire tools) -- display/reference only. NULL means not entered yet (allowed even when pay_type=''salary''). Set via the Staff edit modal only.';
COMMENT ON COLUMN public.employees.salary_period IS
  '''year'' | ''month'' | ''week'' -- the unit salary_amount is quoted in. No default: must be chosen explicitly alongside an amount, or both stay NULL. Application code blocks saving one without the other.';
