-- Sprint 11.7 — lunch_breaks table for employee mid-shift breaks.
--
-- Pattern mirrors time_entries (Migration 032): one row per break, open
-- rows have ended_at NULL, geo-tagged for spot-checks. Separate table
-- from time_entries to keep clock-in/out semantics clean — a lunch row
-- doesn't end the shift, it just records a span inside it.
--
-- RLS: employees insert/update their own; managers see all in business.

CREATE TABLE public.lunch_breaks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  start_lat       numeric,
  start_lng       numeric,
  end_lat         numeric,
  end_lng         numeric,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX idx_lunch_breaks_emp_date
  ON public.lunch_breaks (business_id, employee_id, started_at DESC)
  WHERE deleted_at IS NULL;

-- Open break lookup — "is this employee currently on lunch?"
CREATE INDEX idx_lunch_breaks_open
  ON public.lunch_breaks (business_id, employee_id)
  WHERE ended_at IS NULL AND deleted_at IS NULL;

ALTER TABLE public.lunch_breaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY lunch_breaks_select ON public.lunch_breaks FOR SELECT
USING (
  auth_belongs_to_business(business_id) AND (
    EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = lunch_breaks.employee_id AND e.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
    )
  )
);

CREATE POLICY lunch_breaks_insert ON public.lunch_breaks FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id) AND
  EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = lunch_breaks.employee_id AND e.auth_user_id = auth.uid()
  )
);

CREATE POLICY lunch_breaks_update ON public.lunch_breaks FOR UPDATE
USING (
  auth_belongs_to_business(business_id) AND (
    EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = lunch_breaks.employee_id AND e.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
    )
  )
)
WITH CHECK (
  auth_belongs_to_business(business_id) AND (
    EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id = lunch_breaks.employee_id AND e.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
    )
  )
);

CREATE OR REPLACE FUNCTION public.touch_lunch_breaks_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER lunch_breaks_updated_at
  BEFORE UPDATE ON public.lunch_breaks
  FOR EACH ROW EXECUTE FUNCTION public.touch_lunch_breaks_updated_at();

GRANT SELECT, INSERT, UPDATE ON public.lunch_breaks TO authenticated;
