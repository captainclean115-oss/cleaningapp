-- Structured "Day off" categories. Previously "Day Off" was a single
-- flag (team = 'OFF', collapsed to null by every reader) with no way
-- to say WHY someone is off. Adds a categorized status alongside the
-- existing OFF mechanism, plus optional notes and a real audit trail
-- for who set it.
--
-- Scope (explicit, per Tom): capture the data correctly and expose the
-- categorized status. Downstream consumers (churn card, HR reports,
-- vacation tracking) are NOT built here -- future PRs.

ALTER TABLE public.daily_assignments
  ADD COLUMN status_type text,
  ADD COLUMN notes text;

-- Only meaningful on an OFF row -- a normal team assignment never has
-- a day-off category.
ALTER TABLE public.daily_assignments
  ADD CONSTRAINT daily_assignments_status_type_requires_off
  CHECK (status_type IS NULL OR team = 'OFF');

ALTER TABLE public.daily_assignments
  ADD CONSTRAINT daily_assignments_status_type_allowed_values
  CHECK (status_type IS NULL OR status_type IN (
    'vacation',
    'excused_absence',
    'unexcused_absence',
    'no_call_no_show',
    'not_scheduled'
  ));

-- Audit "who": created_by has existed since this table's original
-- migration but was never actually populated by any INSERT path
-- (confirmed live: 0 of 352 existing rows have it set). A column
-- DEFAULT of auth.uid() is the standard Supabase pattern here --
-- works for direct PostgREST inserts (not just SECURITY DEFINER RPCs),
-- requires no browser-side change to remember to pass it, and can't be
-- spoofed by a caller since it's populated server-side. "When" is
-- already covered by created_at's existing now() default.
ALTER TABLE public.daily_assignments
  ALTER COLUMN created_by SET DEFAULT auth.uid();
