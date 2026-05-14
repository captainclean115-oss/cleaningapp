-- v11.0.20 — Phase D: Chat persistence.
--
-- Manager ↔ employee chat thread storage. Replaces the localStorage-only
-- `cleanco_staff_chats` key (which only worked when both parties used the
-- same physical browser — i.e. demo mode only).
--
-- Shape:
--   one row per message, threaded by employee. `thread_employee_id` is
--   the employee the conversation is WITH (not necessarily the sender —
--   a manager sending to Viviana writes a row with thread_employee_id =
--   Viviana's employees.id and sender_role = 'manager').
--
--   `tx` jsonb pre-computes translations into all four supported langs
--   ({en, es, pt, cv}) at send time via the translate-message Edge
--   Function. The renderer prefers tx[receiver's lang] over text.
--
--   Read receipts: read_at_admin / read_at_emp track the two sides
--   independently. Manager marks read_at_admin when opening a thread;
--   employee marks read_at_emp.
--
-- Audit_log capture: see mig 058 — INSERT → action_type='created',
-- read_at updates are filtered out to avoid audit log noise.

CREATE TABLE public.chat_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  thread_employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  sender_user_id       uuid REFERENCES public.users(id),
  sender_role          text NOT NULL CHECK (sender_role IN ('manager','employee')),
  text                 text NOT NULL,
  lang                 text NOT NULL DEFAULT 'en' CHECK (lang IN ('en','es','pt','cv')),
  tx                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  urgent               boolean NOT NULL DEFAULT false,
  read_at_admin        timestamptz,
  read_at_emp          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_messages_thread
  ON public.chat_messages (business_id, thread_employee_id, created_at DESC);

CREATE INDEX idx_chat_messages_unread_admin
  ON public.chat_messages (business_id, thread_employee_id)
  WHERE read_at_admin IS NULL AND sender_role = 'employee';

CREATE INDEX idx_chat_messages_unread_emp
  ON public.chat_messages (business_id, thread_employee_id)
  WHERE read_at_emp IS NULL AND sender_role = 'manager';

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- Manager-tier (owner / admin / manager / dispatcher) sees all threads
-- in their tenant. Two SELECT policies are OR'd by PostgreSQL, so the
-- employee policy below adds visibility without removing this one.
CREATE POLICY chat_messages_select_mgr ON public.chat_messages FOR SELECT
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager','dispatcher')
  )
);

-- Employee (incl. team_leader) sees only their own thread. We resolve
-- the employee row directly via employees.auth_user_id rather than via
-- public.users.id, since employees.user_id doesn't exist on this schema.
CREATE POLICY chat_messages_select_emp ON public.chat_messages FOR SELECT
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND thread_employee_id IN (
    SELECT id FROM public.employees WHERE auth_user_id = auth.uid() AND deleted_at IS NULL
  )
);

-- INSERT: same tenant, and sender_user_id must match the caller's users.id.
CREATE POLICY chat_messages_insert ON public.chat_messages FOR INSERT
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
  AND sender_user_id = (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
);

-- UPDATE: same tenant. In practice only read_at_admin / read_at_emp
-- get patched. No DELETE policy — chat is immutable.
CREATE POLICY chat_messages_update ON public.chat_messages FOR UPDATE
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
)
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

GRANT SELECT, INSERT, UPDATE ON public.chat_messages TO authenticated;

-- Realtime: subscribe needs the table to be in the supabase_realtime
-- publication. ALTER PUBLICATION ADD TABLE is idempotent via the
-- DO block guard since ADD doesn't have IF NOT EXISTS in older PG.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages';
  END IF;
END $$;
