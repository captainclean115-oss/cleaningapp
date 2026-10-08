-- Migration 113: Admin/Office work type for employees.
--
-- Problem: an office-only employee (e.g. Linda) has no team and no
-- place to be. Today she'd show up in every "Unassigned" list next to
-- genuinely-unplaced field employees with no way to tell the two apart,
-- and -- confirmed by reading the actual code, not assumed -- every
-- team-scoped hours surface (the employee portal's renderHours, Claire's
-- get_employee_hours) uses "this employee has no team today" as its
-- signal for "mark the whole day OFF", which would silently mask her
-- real manual_hour_overrides entries behind a false "Off" status.
--
-- No existing column fits. Checked all of them before adding this:
--   - `position` ('team_leader'|'team_member'|'manager') is a role/
--     seniority axis, not field-vs-office -- repurposing it would
--     conflate the two and break the TL-star-badge logic.
--   - `status`, `team_id`/`team_text` all mean something else already.
--   - No `department`/`employee_type`/`is_admin` column exists anywhere
--     in this table's history (checked every migration that touches
--     public.employees).
--
-- New nullable column, matching the existing convention of a text CHECK
-- constraint + application-side default (see `position`, `pay_type`).
ALTER TABLE public.employees
  ADD COLUMN work_type text DEFAULT 'field'
    CHECK (work_type IN ('field', 'admin'));

COMMENT ON COLUMN public.employees.work_type IS
  '''field'' (default): a cleaning-team employee, resolved via team_id/team_text/daily_assignments like today. ''admin'': an office/admin employee with no team at all -- never appears in team rosters, Unassigned lists, or GPS/device resolution; hours come exclusively from manual_hour_overrides (migration 110). Set via the Staff edit modal''s Work Type control only -- never backfilled by this migration.';

-- Explicit backfill, not relying on the column DEFAULT alone, so this
-- stays self-documenting and safely re-runnable.
UPDATE public.employees SET work_type = 'field' WHERE work_type IS NULL;
