-- v11.0.9 — Job Issue system (Phase A).
--
-- Replaces the legacy localStorage-backed Report Issue flow (which was
-- the "STUB" item from the employee schedule audit). New flow:
-- employee taps an issue chip → row inserted here → manager sees the
-- red dot on the Schedule home tile + an Issues section on the job
-- card.
--
-- Manager-only resolution. No client SMS path (was demo-only before).
-- Audit_log captures inserts + resolves via the trigger extension in
-- mig 048.
--
-- ding_target column is the anchor for the future Service Quality
-- Score / Team Health Score work. Set at insert time by the app
-- (PentaJobIssues.report) per the rules:
--   locked_out / no_one_home + within_window=true  → 'client'
--   locked_out / no_one_home + within_window=false → 'none'
--   cant_find_house                                → 'none'
--   forgot_key, running_late                       → 'staff'
--
-- within_window = report time within ±1hr of scheduled_start_at.
-- Both snapshotted at insert; never recomputed.

CREATE TABLE public.job_issues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  job_id              uuid NOT NULL,
  client_id           uuid,
  reported_by         uuid REFERENCES public.users(id),
  issue_type          text NOT NULL CHECK (issue_type IN (
                        'locked_out','no_one_home','cant_find_house',
                        'forgot_key','running_late'
                      )),
  notes               text,
  reported_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES public.users(id),
  resolution_note     text,
  scheduled_start_at  timestamptz,
  within_window       boolean,
  ding_target         text CHECK (ding_target IN ('client','staff','none')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_issues_business_unresolved
  ON public.job_issues (business_id, resolved_at)
  WHERE resolved_at IS NULL;

CREATE INDEX idx_job_issues_job
  ON public.job_issues (business_id, job_id);

CREATE INDEX idx_job_issues_client
  ON public.job_issues (business_id, client_id)
  WHERE client_id IS NOT NULL;

ALTER TABLE public.job_issues ENABLE ROW LEVEL SECURITY;

-- Same-tenant gate on SELECT / INSERT / UPDATE per Tom's spec. UPDATE
-- is needed for the resolve flow. No DELETE policy — issues are
-- append-only; the resolve action mutates the row, not deletes it.
CREATE POLICY job_issues_select ON public.job_issues FOR SELECT
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY job_issues_insert ON public.job_issues FOR INSERT
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY job_issues_update ON public.job_issues FOR UPDATE
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
)
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

GRANT SELECT, INSERT, UPDATE ON public.job_issues TO authenticated;
