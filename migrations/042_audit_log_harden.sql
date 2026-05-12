-- v11.0.6 — Audit log foundation, part 1 of 4: schema hardening.
--
-- audit_log existed with the right shape but 0 writers + a single open
-- SELECT policy. This migration:
--   1. Locks action_type to a controlled vocabulary via CHECK
--   2. Adds entity_type CHECK to prevent typo drift
--   3. Adds the two indexes that Sync Report + per-entity history need
--   4. Replaces the open SELECT policy with a role-gated triple
--      mirroring the time_entries SELECT pattern
--   5. Adds an INSERT policy so the trigger function + app-level
--      supplements can write (the trigger function is SECURITY DEFINER
--      anyway but the policy is also tight as a defense-in-depth)
--
-- Cutover date for "events are captured from here forward": the
-- timestamp of the next migration (043 — triggers attached). Rows in
-- audit_log predating that ts will be limited to whatever the
-- v11.0.x architecture work has already inserted (currently zero).

-- ─── 1. Controlled vocabularies ──────────────────────────────────
-- Drop and re-add to handle any future evolution cleanly.
ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_type_chk;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_action_type_chk CHECK (action_type IN (
    'created','updated','deleted','restored',
    'moved','cancelled','started','ended',
    'submitted','approved','rejected',
    'manual_note','manual_override',
    'received','refunded'
  ));

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_entity_type_chk;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN (
    'job','client','employee','payment',
    'application','time_entry','lunch_break',
    'daily_assignment','client_key','office',
    'team','system'
  ));

-- ─── 2. Indexes ──────────────────────────────────────────────────
-- (a) Time-range queries per tenant — Sync Report's primary path.
CREATE INDEX IF NOT EXISTS audit_log_business_created_at_idx
  ON public.audit_log (business_id, created_at DESC);

-- (b) Per-entity history — Client Activity Log's primary path,
--     plus any future "what's changed on this job?" view.
CREATE INDEX IF NOT EXISTS audit_log_business_entity_idx
  ON public.audit_log (business_id, entity_type, entity_id, created_at DESC);

-- (c) BRIN on created_at for cheap pruning at scale (audit_log will
--     grow unbounded; partitioning is the future play but BRIN buys
--     time and costs nothing today).
CREATE INDEX IF NOT EXISTS audit_log_created_at_brin
  ON public.audit_log USING BRIN (created_at);

-- ─── 3. RLS — role-gated SELECT ─────────────────────────────────
-- Drop the existing open policy.
DROP POLICY IF EXISTS audit_log_select ON public.audit_log;

-- Owners + admins + managers: full visibility within their tenant.
-- Sees all events, including payment + employee pay changes.
CREATE POLICY audit_log_select_manager_tier ON public.audit_log
FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role IN ('owner','admin','manager')
  )
);

-- Dispatchers: jobs + daily_assignments + applications scope.
-- They don't need to see payment events or employee pay changes.
CREATE POLICY audit_log_select_dispatcher ON public.audit_log
FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role = 'dispatcher'
  )
  AND entity_type IN ('job','daily_assignment','application','client','team','office')
);

-- Employees: only their own actions. Used by the employee portal's
-- "my activity" surface if it ever lands.
CREATE POLICY audit_log_select_employee_own ON public.audit_log
FOR SELECT
USING (
  auth_belongs_to_business(business_id)
  AND user_id IS NOT NULL
  AND user_id = (
    SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid()
  )
);

-- ─── 4. INSERT policy ──────────────────────────────────────────
-- App-level supplements run as the authenticated user and need to
-- write events scoped to their tenant. The trigger function in
-- migration 043 is SECURITY DEFINER and bypasses RLS anyway — this
-- policy is the defense-in-depth path for direct app inserts.
DROP POLICY IF EXISTS audit_log_insert ON public.audit_log;
CREATE POLICY audit_log_insert ON public.audit_log
FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id)
  AND (
    -- user_id must either be the caller (their own action) OR NULL
    -- (system event recorded by a service-role caller).
    user_id IS NULL
    OR user_id = (SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid())
  )
);

-- No UPDATE / DELETE policies for audit_log — events are immutable
-- by design. Service role can still mutate for ops needs.

GRANT SELECT, INSERT ON public.audit_log TO authenticated;
