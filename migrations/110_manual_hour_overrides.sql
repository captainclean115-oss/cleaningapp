-- Manual hour overrides (Save button in the employee day-detail overlay,
-- Claire's "edit_employee_hours" tool) were being written ONLY to
-- localStorage (empHrs_{empId}_{date}), never to Supabase. Confirmed via
-- full-file read: getEmpHours/saveEmpHours had no server-side write path
-- at all -- these are supposed to be authoritative payroll corrections,
-- not a device-local cache, and being localStorage-only meant (a) they
-- were invisible on any other browser/device, including the same
-- manager's own phone vs. desktop and the employee's own portal login on
-- their own device, (b) they were permanently lost if localStorage was
-- ever cleared, and (c) the "hitting quota limits" symptom reported was
-- a direct consequence of piling authoritative business data into a
-- per-origin storage quota that was never meant to hold it.
--
-- Modeled on lunch_flag_overrides (migration 101), the most recent
-- precedent for a small correction-style table written directly by the
-- authenticated client -- same "service_role has no table grants,
-- authenticated writes directly" convention (see that migration's own
-- comment). One row per (business, employee, date), matching the
-- existing empHrs_{empId}_{date} key shape 1:1.
CREATE TABLE public.manual_hour_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date           date NOT NULL,
  start_time     text,
  end_time       text,
  lunch_minutes  integer,
  hours          numeric,
  team           text,
  created_by     uuid REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES public.users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, employee_id, date)
);

CREATE INDEX idx_manual_hour_overrides_business_employee_date
  ON public.manual_hour_overrides(business_id, employee_id, date);

-- The client always sends created_by on every save (so a true INSERT
-- records who made the first correction) -- but a plain upsert's
-- ON CONFLICT DO UPDATE would then silently overwrite created_by with
-- whoever made the LATEST edit every time the same day gets corrected
-- again, destroying "who created this override" the moment anyone
-- edits it a second time. Force created_by/created_at to stay pinned to
-- the original row on every UPDATE; updated_by/updated_at (also always
-- sent) are what track the latest edit.
CREATE FUNCTION public._manual_hour_overrides_preserve_created()
RETURNS trigger AS $$
BEGIN
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER manual_hour_overrides_preserve_created
  BEFORE UPDATE ON public.manual_hour_overrides
  FOR EACH ROW EXECUTE FUNCTION public._manual_hour_overrides_preserve_created();

ALTER TABLE public.manual_hour_overrides ENABLE ROW LEVEL SECURITY;

-- No role restriction on SELECT: the employee portal reads its own
-- corrected hours the same way the manager's Hours tab does.
CREATE POLICY manual_hour_overrides_select ON public.manual_hour_overrides FOR SELECT USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY manual_hour_overrides_insert ON public.manual_hour_overrides FOR INSERT WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
);

CREATE POLICY manual_hour_overrides_update ON public.manual_hour_overrides FOR UPDATE USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
) WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
);

CREATE POLICY manual_hour_overrides_delete ON public.manual_hour_overrides FOR DELETE USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND (SELECT role FROM public.users WHERE auth_user_id = auth.uid()) IN ('owner', 'admin', 'manager')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.manual_hour_overrides TO authenticated;
