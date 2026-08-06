-- PR #98 — CSV audit staging, no import.
--
-- Tom's ask: re-upload the 3 Maids CSVs and let Claude compare them
-- against Penta's current client list WITHOUT running a real import
-- (no client/job writes, no matching, no dedup). This table is the
-- landing zone for the raw parsed CSV rows so the comparison can run
-- as SQL against real data instead of guesswork.
--
-- Explicitly temporary: Tom called it that himself. No cleanup job
-- here — rows are deleted manually (by Tom or a follow-up migration)
-- once the audit report is delivered. Each staging run gets its own
-- run_id so multiple uploads don't collide and the latest one is easy
-- to find (MAX(staged_at) or a fresh run_id per session).

CREATE TABLE public.maids_import_staging (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL,
  source_type   text NOT NULL CHECK (source_type IN ('2026_recurring', '2026_oms', '2025_combined')),
  customer_id   text,
  raw_name      text,
  raw_address   text,
  raw_date      text,
  raw_frequency text,
  raw           jsonb NOT NULL,
  staged_at     timestamptz NOT NULL DEFAULT now(),
  staged_by     uuid REFERENCES public.users(id)
);

CREATE INDEX idx_maids_import_staging_run
  ON public.maids_import_staging (business_id, run_id);

CREATE INDEX idx_maids_import_staging_customer
  ON public.maids_import_staging (business_id, run_id, customer_id);

ALTER TABLE public.maids_import_staging ENABLE ROW LEVEL SECURITY;

-- Same-tenant gate, standard inline-subquery form. No update policy —
-- staged rows are write-once (insert) / delete-when-done, never
-- edited in place.
CREATE POLICY maids_import_staging_select ON public.maids_import_staging FOR SELECT
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY maids_import_staging_insert ON public.maids_import_staging FOR INSERT
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY maids_import_staging_delete ON public.maids_import_staging FOR DELETE
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

GRANT SELECT, INSERT, DELETE ON public.maids_import_staging TO authenticated;
