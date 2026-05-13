-- v11.0.16 — Phase C: Payment Receive system.
--
-- public.payments existed as an empty stub. This migration aligns it
-- with the Phase C spec — renames a few legacy columns, adds the
-- required new ones, adds CHECK constraints, RLS policies, indexes.
-- The audit trigger is already attached (mig 043).
--
-- OCR-related columns (ocr_results / ocr_status / ocr_confidence /
-- ocr_processed_at) are reserved for the future Phase D Edge Function
-- that reads check photos via Claude vision. No app code references
-- them yet — they exist so the migration doesn't have to run again.

-- ─── Renames ──────────────────────────────────────────────────────
ALTER TABLE public.payments RENAME COLUMN applied_to_job_id    TO job_id;
ALTER TABLE public.payments RENAME COLUMN created_by_user_id  TO recorded_by;
ALTER TABLE public.payments RENAME COLUMN vision_extracted_data TO ocr_results;

-- ─── New columns ──────────────────────────────────────────────────
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_method_other text,
  ADD COLUMN IF NOT EXISTS photo_path           text,
  ADD COLUMN IF NOT EXISTS received_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS recorded_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS voided               boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voided_at            timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by            uuid        REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS void_reason          text,
  ADD COLUMN IF NOT EXISTS ocr_status           text,
  ADD COLUMN IF NOT EXISTS ocr_confidence       numeric(3,2),
  ADD COLUMN IF NOT EXISTS ocr_processed_at     timestamptz;

-- ─── CHECK constraints ────────────────────────────────────────────
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_chk;
ALTER TABLE public.payments ADD  CONSTRAINT payments_method_chk
  CHECK (method IN ('cash','check','venmo','zelle','credit_card','other'));

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_amount_chk;
ALTER TABLE public.payments ADD  CONSTRAINT payments_amount_chk
  CHECK (amount > 0);

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_ocr_status_chk;
ALTER TABLE public.payments ADD  CONSTRAINT payments_ocr_status_chk
  CHECK (ocr_status IS NULL OR ocr_status IN ('pending','verified','mismatch','skipped'));

-- ─── Photo retention default ──────────────────────────────────────
-- Existing column was created without a default; spec says 90 days.
ALTER TABLE public.payments ALTER COLUMN photo_expires_at
  SET DEFAULT (now() + interval '90 days');

-- ─── Indexes ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_payments_business_received
  ON public.payments (business_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_client
  ON public.payments (business_id, client_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_job
  ON public.payments (business_id, job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_received_brin
  ON public.payments USING BRIN (received_at);

-- ─── RLS ─────────────────────────────────────────────────────────
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_select ON public.payments;
CREATE POLICY payments_select ON public.payments FOR SELECT
USING (business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid()));

DROP POLICY IF EXISTS payments_insert ON public.payments;
CREATE POLICY payments_insert ON public.payments FOR INSERT
WITH CHECK (business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid()));

-- UPDATE = manager-tier only (void flow). No DELETE policy — use void.
DROP POLICY IF EXISTS payments_update ON public.payments;
CREATE POLICY payments_update ON public.payments FOR UPDATE
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
)
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

GRANT SELECT, INSERT, UPDATE ON public.payments TO authenticated;

-- ─── Drop legacy CHECK constraint that pre-dated this work ───────
-- The original payments table shipped with payments_method_check
-- limiting method to ('check','card','cash','ach','other'). Phase C
-- replaces that with payments_method_chk (cash/check/venmo/zelle/
-- credit_card/other). The two CHECKs are AND'd by Postgres so the
-- legacy one would reject any new method. Drop it.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_check;
