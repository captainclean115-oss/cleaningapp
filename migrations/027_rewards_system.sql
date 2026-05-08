-- Sprint 11.5 — Rewards System v1.
-- Five tables backing PentaRewards facade: catalog config (earn events + redemption
-- catalog) plus three transactional tables (immutable ledger + photo submissions +
-- redemption requests). Soft-delete via deleted_at on the catalog tables; ledger is
-- insert-only (reversals are new rows with source='reversal'). RLS scoped by
-- business_id; manager-tier roles write config; any same-business member can insert
-- ledger/submission/redemption rows; only managers update workflow state. Realtime
-- publication on all 5 so PentaRewards can subscribe per Sprint 10 v10.2.0 pattern.
--
-- Existing localStorage content_points + rewards_ledger NOT migrated — clean slate v1
-- per Tom (demo data only, real points start Mon May 11).

-- =========================================================================
-- reward_events_config — EARN catalog (manager edits, default seeded).
-- =========================================================================
CREATE TABLE public.reward_events_config (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  event_key           text NOT NULL,
  label               text NOT NULL,
  points              integer NOT NULL CHECK (points >= 0),
  is_system           boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  requires_approval   boolean NOT NULL DEFAULT false,
  description         text,
  sort_order          integer NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE UNIQUE INDEX uq_reward_events_config_active
  ON public.reward_events_config (business_id, event_key)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_reward_events_config_business_active
  ON public.reward_events_config (business_id, sort_order)
  WHERE deleted_at IS NULL AND is_active = true;

CREATE TRIGGER reward_events_config_updated_at BEFORE UPDATE ON public.reward_events_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- reward_catalog — REDEMPTION catalog (manager edits, default seeded).
-- =========================================================================
CREATE TABLE public.reward_catalog (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  reward_key          text NOT NULL,
  label               text NOT NULL,
  cost_points         integer NOT NULL CHECK (cost_points > 0),
  is_system           boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  description         text,
  sort_order          integer NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE UNIQUE INDEX uq_reward_catalog_active
  ON public.reward_catalog (business_id, reward_key)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_reward_catalog_business_active
  ON public.reward_catalog (business_id, sort_order)
  WHERE deleted_at IS NULL AND is_active = true;

CREATE TRIGGER reward_catalog_updated_at BEFORE UPDATE ON public.reward_catalog
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- reward_ledger — IMMUTABLE point-change history. Insert-only.
-- Reversals are new rows with source='reversal' and a positive delta.
-- =========================================================================
CREATE TABLE public.reward_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  delta               integer NOT NULL,
  reason              text NOT NULL,
  event_key           text,
  source              text NOT NULL CHECK (source IN ('earn','redeem','manager_grant','adjustment','reversal')),
  reference_id        uuid,
  granted_by          uuid REFERENCES public.users(id),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reward_ledger_employee
  ON public.reward_ledger (business_id, employee_id, created_at DESC);

CREATE INDEX idx_reward_ledger_business_created
  ON public.reward_ledger (business_id, created_at DESC);

-- =========================================================================
-- reward_submissions — Employee photo submissions awaiting manager approval.
-- =========================================================================
CREATE TABLE public.reward_submissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  submission_type     text NOT NULL DEFAULT 'photo'
                      CHECK (submission_type IN ('photo','referral','review','custom')),
  photo_path          text,
  caption             text,
  client_id           uuid REFERENCES public.clients(id),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected')),
  reviewed_by         uuid REFERENCES public.users(id),
  reviewed_at         timestamptz,
  rejection_reason    text,
  awarded_event_key   text,
  awarded_points      integer,
  ledger_id           uuid REFERENCES public.reward_ledger(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX idx_reward_submissions_status
  ON public.reward_submissions (business_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_reward_submissions_employee
  ON public.reward_submissions (business_id, employee_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER reward_submissions_updated_at BEFORE UPDATE ON public.reward_submissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- reward_redemptions — Employee redemption requests + fulfillment workflow.
-- =========================================================================
CREATE TABLE public.reward_redemptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  reward_key          text NOT NULL,
  reward_label        text NOT NULL,
  cost_points         integer NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','fulfilled','rejected','cancelled')),
  ledger_id           uuid REFERENCES public.reward_ledger(id),
  fulfilled_by        uuid REFERENCES public.users(id),
  fulfilled_at        timestamptz,
  rejection_reason    text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX idx_reward_redemptions_status
  ON public.reward_redemptions (business_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_reward_redemptions_employee
  ON public.reward_redemptions (business_id, employee_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER reward_redemptions_updated_at BEFORE UPDATE ON public.reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- RLS — enable + policies per table.
-- Pattern matches Migration 025 (jobs): same-business SELECT for all members,
-- manager-tier roles for writes. ledger UPDATE/DELETE intentionally absent
-- (RLS denies by default — enforces immutability).
-- =========================================================================

ALTER TABLE public.reward_events_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_catalog       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_ledger        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_submissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_redemptions   ENABLE ROW LEVEL SECURITY;

-- ---- reward_events_config (config table — manager-tier writes) ----
CREATE POLICY reward_events_config_select ON public.reward_events_config FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY reward_events_config_insert ON public.reward_events_config FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

CREATE POLICY reward_events_config_update ON public.reward_events_config FOR UPDATE
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

CREATE POLICY reward_events_config_delete ON public.reward_events_config FOR DELETE
USING (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

-- ---- reward_catalog (config table — manager-tier writes) ----
CREATE POLICY reward_catalog_select ON public.reward_catalog FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY reward_catalog_insert ON public.reward_catalog FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

CREATE POLICY reward_catalog_update ON public.reward_catalog FOR UPDATE
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

CREATE POLICY reward_catalog_delete ON public.reward_catalog FOR DELETE
USING (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

-- ---- reward_ledger (any same-business INSERT — managers grant, employees earn
-- via approve/redeem flows. UPDATE/DELETE intentionally absent: RLS denies by
-- default → table is append-only. Reversals are new rows with source='reversal'.)
CREATE POLICY reward_ledger_select ON public.reward_ledger FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY reward_ledger_insert ON public.reward_ledger FOR INSERT
WITH CHECK (auth_belongs_to_business(business_id));

-- ---- reward_submissions (any same-business INSERT — employee submits own;
-- manager-tier UPDATE for approval workflow.)
CREATE POLICY reward_submissions_select ON public.reward_submissions FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY reward_submissions_insert ON public.reward_submissions FOR INSERT
WITH CHECK (auth_belongs_to_business(business_id));

CREATE POLICY reward_submissions_update ON public.reward_submissions FOR UPDATE
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

CREATE POLICY reward_submissions_delete ON public.reward_submissions FOR DELETE
USING (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

-- ---- reward_redemptions (any same-business INSERT — employee requests;
-- manager-tier UPDATE for fulfillment workflow.)
CREATE POLICY reward_redemptions_select ON public.reward_redemptions FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY reward_redemptions_insert ON public.reward_redemptions FOR INSERT
WITH CHECK (auth_belongs_to_business(business_id));

CREATE POLICY reward_redemptions_update ON public.reward_redemptions FOR UPDATE
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

CREATE POLICY reward_redemptions_delete ON public.reward_redemptions FOR DELETE
USING (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

-- =========================================================================
-- Grants — RLS gates the rows; GRANT gates the verbs.
-- ledger explicitly omits UPDATE/DELETE so even an attempt at the verb fails.
-- =========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_events_config TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_catalog       TO authenticated;
GRANT SELECT, INSERT                  ON public.reward_ledger        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_submissions   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_redemptions   TO authenticated;

-- =========================================================================
-- Realtime publication — subscribe in PentaRewards per Sprint 10 v10.2.0 pattern.
-- =========================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.reward_events_config;
ALTER PUBLICATION supabase_realtime ADD TABLE public.reward_catalog;
ALTER PUBLICATION supabase_realtime ADD TABLE public.reward_ledger;
ALTER PUBLICATION supabase_realtime ADD TABLE public.reward_submissions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.reward_redemptions;

-- =========================================================================
-- Seeds for Manna Maids (business_id = 48532f06-0625-415b-9091-2638bed6506d).
-- All marked is_system=true so manager UI can edit but not delete them.
-- =========================================================================

-- 11 default earn events.
INSERT INTO public.reward_events_config
  (business_id, event_key, label, points, is_system, is_active, requires_approval, sort_order) VALUES
  ('48532f06-0625-415b-9091-2638bed6506d', 'photo_submitted',      'Photo submitted',                50,  true, true, true,  10),
  ('48532f06-0625-415b-9091-2638bed6506d', 'photo_posted_bonus',   'Photo posted bonus',             25,  true, true, false, 20),
  ('48532f06-0625-415b-9091-2638bed6506d', 'full_day_worked',      'Full day worked',                25,  true, true, false, 30),
  ('48532f06-0625-415b-9091-2638bed6506d', 'perfect_week',         'Perfect attendance week',        100, true, true, false, 40),
  ('48532f06-0625-415b-9091-2638bed6506d', 'five_star_review',     'Client 5-star review',           200, true, true, false, 50),
  ('48532f06-0625-415b-9091-2638bed6506d', 'qr_issue_logged',      'QR issue logged',                30,  true, true, false, 60),
  ('48532f06-0625-415b-9091-2638bed6506d', 'client_referral',      'Client referral signed',         300, true, true, false, 70),
  ('48532f06-0625-415b-9091-2638bed6506d', 'staff_referral_hired', 'Staff referral hired',           500, true, true, false, 80),
  ('48532f06-0625-415b-9091-2638bed6506d', 'above_and_beyond',     'Above & beyond (manager flag)',  100, true, true, false, 90),
  ('48532f06-0625-415b-9091-2638bed6506d', 'client_thank_you',     'Client thank-you note',          75,  true, true, false, 100),
  ('48532f06-0625-415b-9091-2638bed6506d', 'birthday_anniversary', 'Birthday / work anniversary',    250, true, true, false, 110);

-- 5 default redemption catalog items.
INSERT INTO public.reward_catalog
  (business_id, reward_key, label, cost_points, is_system, is_active, sort_order) VALUES
  ('48532f06-0625-415b-9091-2638bed6506d', 'cash_10',       '$10 cash',       500,  true, true, 10),
  ('48532f06-0625-415b-9091-2638bed6506d', 'gift_card_25',  '$25 gift card',  1000, true, true, 20),
  ('48532f06-0625-415b-9091-2638bed6506d', 'half_day_off',  'Half day off',   2000, true, true, 30),
  ('48532f06-0625-415b-9091-2638bed6506d', 'full_day_off',  'Full day off',   3500, true, true, 40),
  ('48532f06-0625-415b-9091-2638bed6506d', 'cash_100',      '$100 cash',      5000, true, true, 50);
