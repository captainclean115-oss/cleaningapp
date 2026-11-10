-- Claire safety foundation (Stage 2a, PR: claire-foundation).
--
-- Two new tables. Nothing on any existing table changes.
--
-- Naming note: a table literally named `claire_conversations` already
-- exists in this database -- unrelated, dead scaffolding (confirmed
-- zero rows, zero references anywhere in index.html) from some earlier
-- sprint, with a completely different schema (conversation_title/
-- started_at/ended_at/context_summary/archived) and a business-wide
-- readable RLS model (any business member can read any row via
-- auth_belongs_to_business alone) that's the OPPOSITE of the private-
-- by-default model this migration needs. Confirmed via a first attempt
-- that hit "column updated_at does not exist" -- CREATE TABLE IF NOT
-- EXISTS silently no-op'd against that old table instead of creating a
-- new one. Not touched, not dropped, not altered -- this migration
-- just uses a different name, claire_chat_sessions, to avoid it
-- entirely. If that old table ever needs cleaning up, that's a
-- separate, deliberate decision for later, not bundled into this one.
--
-- 1. claire_chat_sessions -- saved chat history, PRIVATE BY DEFAULT.
--    A user can read/insert/update/delete ONLY her own rows
--    (user_id = auth.uid()), scoped to her own business. This is
--    deliberate: NOT EVEN OWNER/ADMIN can read another user's saved
--    Claire conversation through this table's RLS. A manager's
--    conversation with Claire is hers alone. (If Tom ever needs
--    oversight of what a manager asked Claire, that's a separate,
--    future decision -- not something this migration grants by
--    accident.) claire_proposals (below) is the SEPARATE, intentionally
--    shared surface for anything that actually needs owner/admin
--    visibility -- a proposed write, never the surrounding chat.
--
-- 2. claire_proposals -- the approval-gate queue. Every WRITE-classified
--    Claire tool call becomes a row here instead of executing
--    immediately. owner/admin can read every proposal in their
--    business; manager/dispatcher can read/insert only their OWN
--    risk='normal' rows (a manager can never even INSERT a
--    risk='sensitive' row -- enforced here, not just client-side, so
--    a client bug can't let a sensitive proposal slip through as a
--    manager's own). Only owner/admin can update ANY row; the
--    creator can additionally update (e.g. self-cancel) their own
--    non-sensitive row. No DELETE policy for anyone -- a decided
--    proposal is a permanent record, never erased.
--
-- Run twice safely: IF NOT EXISTS / DROP POLICY IF EXISTS before
-- CREATE POLICY throughout.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. claire_chat_sessions
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.claire_chat_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title          text,
  messages       jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_count  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claire_chat_sessions_user
  ON public.claire_chat_sessions (business_id, user_id, updated_at DESC);

ALTER TABLE public.claire_chat_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claire_chat_sessions_select ON public.claire_chat_sessions;
CREATE POLICY claire_chat_sessions_select ON public.claire_chat_sessions FOR SELECT
USING (auth_belongs_to_business(business_id) AND user_id = auth.uid());

DROP POLICY IF EXISTS claire_chat_sessions_insert ON public.claire_chat_sessions;
CREATE POLICY claire_chat_sessions_insert ON public.claire_chat_sessions FOR INSERT
WITH CHECK (auth_belongs_to_business(business_id) AND user_id = auth.uid());

DROP POLICY IF EXISTS claire_chat_sessions_update ON public.claire_chat_sessions;
CREATE POLICY claire_chat_sessions_update ON public.claire_chat_sessions FOR UPDATE
USING (auth_belongs_to_business(business_id) AND user_id = auth.uid())
WITH CHECK (auth_belongs_to_business(business_id) AND user_id = auth.uid());

DROP POLICY IF EXISTS claire_chat_sessions_delete ON public.claire_chat_sessions;
CREATE POLICY claire_chat_sessions_delete ON public.claire_chat_sessions FOR DELETE
USING (auth_belongs_to_business(business_id) AND user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claire_chat_sessions TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. claire_proposals
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.claire_proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  source           text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'scheduled')),
  conversation_id  uuid REFERENCES public.claire_chat_sessions(id) ON DELETE SET NULL,
  tool_name        text NOT NULL,
  args             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Plain-English summary -- no more detail than the screen already
  -- shows (no names/addresses/pay amounts beyond what the existing
  -- preview text for that tool would show).
  summary          text NOT NULL,
  risk             text NOT NULL DEFAULT 'normal' CHECK (risk IN ('normal', 'sensitive')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  decided_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  executed_at      timestamptz,
  result           jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '48 hours')
);

CREATE INDEX IF NOT EXISTS idx_claire_proposals_business_status
  ON public.claire_proposals (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claire_proposals_creator
  ON public.claire_proposals (business_id, created_by, status);

ALTER TABLE public.claire_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claire_proposals_select ON public.claire_proposals;
CREATE POLICY claire_proposals_select ON public.claire_proposals FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
    OR (
      created_by = auth.uid() AND risk = 'normal'
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('manager', 'dispatcher'))
    )
  )
);

DROP POLICY IF EXISTS claire_proposals_insert ON public.claire_proposals;
CREATE POLICY claire_proposals_insert ON public.claire_proposals FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND created_by = auth.uid()
  AND (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
    OR (
      risk = 'normal'
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('manager', 'dispatcher'))
    )
  )
);

DROP POLICY IF EXISTS claire_proposals_update ON public.claire_proposals;
CREATE POLICY claire_proposals_update ON public.claire_proposals FOR UPDATE
USING (
  auth_belongs_to_business(business_id)
  AND (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
    OR (
      created_by = auth.uid() AND risk = 'normal'
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('manager', 'dispatcher'))
    )
  )
)
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin'))
    OR (
      created_by = auth.uid() AND risk = 'normal'
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('manager', 'dispatcher'))
    )
  )
);

-- No DELETE policy -- a decided proposal is a permanent record.

GRANT SELECT, INSERT, UPDATE ON public.claire_proposals TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (not applied here -- run this block to undo everything above)
-- ═══════════════════════════════════════════════════════════════════════
-- DROP POLICY IF EXISTS claire_proposals_select ON public.claire_proposals;
-- DROP POLICY IF EXISTS claire_proposals_insert ON public.claire_proposals;
-- DROP POLICY IF EXISTS claire_proposals_update ON public.claire_proposals;
-- DROP TABLE IF EXISTS public.claire_proposals;
-- DROP POLICY IF EXISTS claire_chat_sessions_select ON public.claire_chat_sessions;
-- DROP POLICY IF EXISTS claire_chat_sessions_insert ON public.claire_chat_sessions;
-- DROP POLICY IF EXISTS claire_chat_sessions_update ON public.claire_chat_sessions;
-- DROP POLICY IF EXISTS claire_chat_sessions_delete ON public.claire_chat_sessions;
-- DROP TABLE IF EXISTS public.claire_chat_sessions;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only -- run after applying; see also tools/verify_123.sql)
-- ═══════════════════════════════════════════════════════════════════════
-- SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema='public' AND table_name IN ('claire_chat_sessions','claire_proposals') ORDER BY 1, ordinal_position;
--
-- SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid IN ('public.claire_chat_sessions'::regclass, 'public.claire_proposals'::regclass) ORDER BY 1,2;
--
-- SELECT polrelid::regclass AS table_name, polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
-- FROM pg_policy WHERE polrelid IN ('public.claire_chat_sessions'::regclass, 'public.claire_proposals'::regclass) ORDER BY 1,2;
--
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('claire_chat_sessions','claire_proposals');
--
-- -- Expect zero DELETE policies on claire_proposals:
-- SELECT count(*) FROM pg_policy WHERE polrelid = 'public.claire_proposals'::regclass AND polcmd = 'd';
