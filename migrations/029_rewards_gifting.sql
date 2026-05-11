-- Sprint 11.5+ — Rewards gifting (peer-to-peer points transfers).
-- Augments Migration 027's reward_ledger with two new source enum values and
-- a recipient-linkage column. Each gift produces TWO ledger rows in one
-- PentaRewards.giftPoints() facade call:
--   - sender row:    delta=-points, source='gift_out',
--                    gift_recipient_id=<recipient employees.id>,
--                    reference_id=NULL
--   - recipient row: delta=+points, source='gift_in',
--                    gift_recipient_id=NULL,
--                    reference_id=<sender row's id>     (back-reference)
--
-- Caps (sender-daily 200, sender→recipient-pair-daily 100) are enforced
-- client-side in the facade — kept out of the DB so they can be tuned
-- without another migration. RLS is unchanged: Migration 027's
-- reward_ledger_insert policy (auth_belongs_to_business) already covers
-- both rows of a gift pair (employees insert in their own business).
-- Realtime publication on reward_ledger from Migration 027 still applies.

-- =========================================================================
-- 1) Extend the source-enum CHECK to accept 'gift_out' and 'gift_in'.
-- =========================================================================
ALTER TABLE public.reward_ledger DROP CONSTRAINT reward_ledger_source_check;
ALTER TABLE public.reward_ledger ADD CONSTRAINT reward_ledger_source_check
  CHECK (source IN ('earn','redeem','manager_grant','adjustment','reversal','gift_out','gift_in'));

-- =========================================================================
-- 2) Add gift_recipient_id linkage column.
--    Set on gift_out rows pointing to the recipient employees.id; NULL on
--    every other row (including gift_in — the recipient row identifies the
--    sender via reference_id back-pointing to the gift_out row).
-- =========================================================================
ALTER TABLE public.reward_ledger
  ADD COLUMN gift_recipient_id uuid REFERENCES public.employees(id);

-- Partial index supporting the recipient-pair cap query in giftPoints (and
-- any future "gifts I sent to X" history view). Caps themselves run off the
-- in-memory _ledger cache so this isn't on the hot path today, but it keeps
-- the FK + server-side gift queries fast.
CREATE INDEX idx_reward_ledger_gift_recipient
  ON public.reward_ledger (business_id, gift_recipient_id, created_at DESC)
  WHERE gift_recipient_id IS NOT NULL;
