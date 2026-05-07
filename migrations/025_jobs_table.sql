-- Sprint 10 Phase 0: jobs table backs the schedule.
-- localStorage['cleanco_jobs'] migrates to this via a one-shot in Phase 2.
-- Realtime subscription wires in Phase 5 so manager phones, desktop, and
-- employee portals stay in sync.
--
-- An empty jobs table from Migration 001 (initial_schema) used a more
-- normalized shape (uuid client_id FK, uuid team_id, time scheduled_start_time,
-- separate actual_* timestamps). It was never populated — the app stayed
-- on localStorage. Per Tom's "team as TEXT, FK deferred" call we recreate
-- with the in-memory-matching shape so the migration + facade rewrite has
-- minimum friction.

DROP TABLE IF EXISTS public.jobs CASCADE;

CREATE TABLE public.jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  -- client_id is TEXT (matches in-memory shape — PentaClients exposes
  -- external_id as `c.id`). FK to clients deferred per Tom's call.
  client_id       text,

  -- Scheduling
  date            date NOT NULL,
  time            text,         -- "HH:MM" 24-hour, kept as text for in-memory parity
  end_time        text,
  flexible        boolean NOT NULL DEFAULT false,
  duration_minutes integer,     -- was `quotedMin` in memory

  -- Team (text shape — FK deferred)
  team            text,

  -- Lifecycle
  status          text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','completed','cancelled')),
  cancel_reason   text,
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES public.users(id),

  -- Content
  notes           text,
  price           numeric,

  -- Provenance
  auto_generated  boolean NOT NULL DEFAULT false,
  legacy_id       text,          -- preserves old in-memory IDs (seed_1, freq_xxxx)

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.users(id)
);

CREATE INDEX idx_jobs_business_date ON public.jobs (business_id, date)
  WHERE status != 'cancelled';
CREATE INDEX idx_jobs_team_date    ON public.jobs (business_id, team, date);
CREATE INDEX idx_jobs_client       ON public.jobs (business_id, client_id);
CREATE INDEX idx_jobs_legacy_id    ON public.jobs (business_id, legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY jobs_select ON public.jobs FOR SELECT
USING (auth_belongs_to_business(business_id));

CREATE POLICY jobs_insert ON public.jobs FOR INSERT
WITH CHECK (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

CREATE POLICY jobs_update ON public.jobs FOR UPDATE
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

CREATE POLICY jobs_delete ON public.jobs FOR DELETE
USING (
  auth_belongs_to_business(business_id) AND
  EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid()
          AND u.role IN ('owner','admin','manager','dispatcher'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.jobs TO authenticated;

-- Realtime: add jobs to supabase_realtime publication so PentaJobs can
-- subscribe to postgres_changes events.
ALTER PUBLICATION supabase_realtime ADD TABLE public.jobs;
