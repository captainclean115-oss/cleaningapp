-- Payroll cost tally + employee estimated pay (PR: payroll-cost-and-rates).
--
-- Renumbered to 117, not 116: migrations/116_phone_login_support.sql
-- already claimed 116 on the phone-password-login branch (PR #199),
-- built on this same branch point. No schema overlap between the two,
-- just numbering -- same situation as the earlier 114 collision with
-- PR #196, handled the same way (renumber before anything is applied).
--
-- Two things, both NEW, no ALTER to any existing table here (the
-- published_employee_hours additions are a separate migration, 118,
-- since they're a distinct concern -- per-day rate snapshots, not
-- business-wide settings):
--
--   1. business_payroll_settings -- one row per business. Employer tax
--      rates + the overtime toggle. EVERY rate field defaults to NULL,
--      not 0 -- "nothing is estimated until Tom enters it" is the whole
--      point, and a silent 0% would look like a real, deliberate answer
--      instead of "not configured yet". RLS: owner/admin/manager/
--      dispatcher only, matching this app's existing manager-tier
--      convention (published_employee_hours, manual_hour_overrides) --
--      an employee can never read a single row of this table, not even
--      her own business's.
--
--   2. businesses.show_estimated_pay_to_employees -- a single boolean,
--      deliberately NOT in business_payroll_settings. The portal needs
--      to know whether to show its estimated-pay line at all, which
--      means an EMPLOYEE session has to be able to read this one flag --
--      but nothing else in payroll settings is safe for her to see. The
--      businesses table's own SELECT policy already has no role
--      restriction (auth_belongs_to_business(id) OR franchisor access,
--      confirmed by reading pg_policies directly) -- any business member
--      can already read her own business's row, so this one flag rides
--      that existing, already-correct policy for free. No new function,
--      no new policy, no new attack surface.
CREATE TABLE IF NOT EXISTS public.business_payroll_settings (
  business_id                uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  social_security_pct        numeric(6,3) CHECK (social_security_pct IS NULL OR (social_security_pct >= 0 AND social_security_pct <= 100)),
  medicare_pct               numeric(6,3) CHECK (medicare_pct IS NULL OR (medicare_pct >= 0 AND medicare_pct <= 100)),
  federal_unemployment_pct   numeric(6,3) CHECK (federal_unemployment_pct IS NULL OR (federal_unemployment_pct >= 0 AND federal_unemployment_pct <= 100)),
  state_unemployment_pct     numeric(6,3) CHECK (state_unemployment_pct IS NULL OR (state_unemployment_pct >= 0 AND state_unemployment_pct <= 100)),
  other_employer_costs_pct   numeric(6,3) CHECK (other_employer_costs_pct IS NULL OR (other_employer_costs_pct >= 0 AND other_employer_costs_pct <= 100)),
  -- Overtime is scoped to the Hours table's own Mon-Fri week, NOT a true
  -- Monday-Sunday pay week -- see this migration's own comment block
  -- further down ("OVERTIME SCOPE") for why that's a real, disclosed
  -- limitation, not an oversight.
  overtime_enabled           boolean NOT NULL DEFAULT false,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS show_estimated_pay_to_employees boolean NOT NULL DEFAULT false;

ALTER TABLE public.business_payroll_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_payroll_settings_select ON public.business_payroll_settings;
CREATE POLICY business_payroll_settings_select ON public.business_payroll_settings FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager','dispatcher'))
);

DROP POLICY IF EXISTS business_payroll_settings_insert ON public.business_payroll_settings;
CREATE POLICY business_payroll_settings_insert ON public.business_payroll_settings FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager','dispatcher'))
);

DROP POLICY IF EXISTS business_payroll_settings_update ON public.business_payroll_settings;
CREATE POLICY business_payroll_settings_update ON public.business_payroll_settings FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager','dispatcher'))
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager','dispatcher'))
);

DROP POLICY IF EXISTS business_payroll_settings_delete ON public.business_payroll_settings;
CREATE POLICY business_payroll_settings_delete ON public.business_payroll_settings FOR DELETE
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager','dispatcher'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_payroll_settings TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- OVERTIME SCOPE -- a real, disclosed limitation, not an oversight.
-- ═══════════════════════════════════════════════════════════════════════
-- migrations/111_pay_week_start_day.sql already set Manna's pay week to
-- Monday-Sunday (businesses.pay_week_start_day = 'monday', confirmed
-- live). But getWeekDates(offset) in index.html -- what the manager
-- Hours table, Live tab, and Published Hours all use for "the week" --
-- is hardcoded to 5 days: `for (let i = 0; i < 5; i++) { // Mon-Fri only }`.
-- It never returns Saturday or Sunday, and nothing anywhere in this app
-- (Hours table, Live tab, Published Hours) currently surfaces a weekend
-- hour at all, even if time_entries has one.
--
-- This means a TRUE "hours over 40 in the Monday-Sunday pay week"
-- overtime calculation cannot be done correctly today -- any employee
-- who also works a Saturday or Sunday would have those hours invisible
-- to this whole system, so overtime computed only from the visible
-- Mon-Fri days would silently UNDERCOUNT her real weekly total.
--
-- Scope decision for this PR (overtime_enabled, when true): overtime is
-- computed ONLY within the 5 displayed Mon-Fri days -- hours over 40
-- across those 5 days, not a true 7-day pay week. The payroll cost card
-- and Claire's deflection text both say "this week" only (the viewed
-- Mon-Fri range), never "pay week," to avoid implying a guarantee this
-- system cannot back. If Manna's employees ever work weekends, this
-- needs real work (surfacing Saturday/Sunday somewhere first) before
-- "Monday-Sunday overtime" can be literally true -- not something to
-- silently paper over with this flag's name alone.

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (not applied -- run this block to undo everything above)
-- ═══════════════════════════════════════════════════════════════════════
-- DROP POLICY IF EXISTS business_payroll_settings_select ON public.business_payroll_settings;
-- DROP POLICY IF EXISTS business_payroll_settings_insert ON public.business_payroll_settings;
-- DROP POLICY IF EXISTS business_payroll_settings_update ON public.business_payroll_settings;
-- DROP POLICY IF EXISTS business_payroll_settings_delete ON public.business_payroll_settings;
-- DROP TABLE IF EXISTS public.business_payroll_settings;
-- ALTER TABLE public.businesses DROP COLUMN IF EXISTS show_estimated_pay_to_employees;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run after applying)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='business_payroll_settings' ORDER BY ordinal_position;
--
-- SELECT polname, polcmd FROM pg_policy
-- WHERE polrelid = 'public.business_payroll_settings'::regclass;
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='businesses' AND column_name='show_estimated_pay_to_employees';
