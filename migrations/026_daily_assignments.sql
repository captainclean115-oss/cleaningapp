-- Sprint 10 Phase 1: daily_assignments table.
-- Replaces localStorage['daily_assignments'] which was keyed
-- `<date>_<empId>` → team. Soft-delete via deleted_at so realtime
-- subscribers can distinguish "removed" from "never existed."
--
-- A given employee can be on at most one team per day — enforced by
-- the partial unique index on active rows. Reassigning the same
-- employee to a different team on the same day requires the facade
-- to soft-delete the old row before inserting the new one.

CREATE TABLE public.daily_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  date            date NOT NULL,
  team            text NOT NULL,
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.users(id),
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES public.users(id)
);

-- One active assignment per (business, date, team, employee).
CREATE UNIQUE INDEX uq_daily_assignments_active
  ON public.daily_assignments (business_id, date, team, employee_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_daily_assignments_business_date
  ON public.daily_assignments (business_id, date)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_daily_assignments_employee
  ON public.daily_assignments (business_id, employee_id, date)
  WHERE deleted_at IS NULL;

ALTER TABLE public.daily_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY daily_assignments_select ON public.daily_assignments FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY daily_assignments_insert ON public.daily_assignments FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

CREATE POLICY daily_assignments_update ON public.daily_assignments FOR UPDATE
USING (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
)
WITH CHECK (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

CREATE POLICY daily_assignments_delete ON public.daily_assignments FOR DELETE
USING (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_assignments TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_assignments;
