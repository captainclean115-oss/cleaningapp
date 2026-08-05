-- 087 — Maids CSV importer (PR #78).
--
-- Adds the columns/table/RPC needed for a re-runnable Maids-export
-- importer. Client-side (JS) resolves ALL matching decisions before
-- calling this RPC (fuzzy name/address scoring, per-row manager
-- confirmation for 70-89% matches, team/status/holiday mapping) — the
-- RPC's job is purely mechanical: given an already-resolved payload,
-- write it atomically and recompute derived client stats.
--
-- jobs.time/end_time (existing text columns, already read everywhere
-- in the app for rendering) are populated alongside the new
-- scheduled_start_time/scheduled_end_time (time-typed) columns so
-- existing Schedule/GPS-matching code keeps working unchanged; the new
-- columns are the precise dedup key + a future home for schedule-board
-- rendering work (explicitly deferred, not built here).
--
-- duration_minutes is NOT duplicated as "quoted_minutes" -- it's
-- already treated as quoted minutes throughout the app
-- (PentaJobs._fromRow maps it to quotedMin). Only actual_minutes is
-- new.

-- ── jobs ────────────────────────────────────────────────────────────
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS scheduled_start_time time,
  ADD COLUMN IF NOT EXISTS scheduled_end_time   time,
  ADD COLUMN IF NOT EXISTS balance_due          numeric,
  ADD COLUMN IF NOT EXISTS actual_minutes       integer,
  ADD COLUMN IF NOT EXISTS cancellation_type    text,
  ADD COLUMN IF NOT EXISTS team_code_raw        text,
  ADD COLUMN IF NOT EXISTS is_multi_visit_day   boolean NOT NULL DEFAULT false;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_cancellation_type_check
  CHECK (cancellation_type IS NULL OR cancellation_type IN ('company_closure', 'client_initiated'));

-- Dedup key Tom specified: same client + same date + same start time =
-- same job (update on re-import); a different start time is a genuine
-- separate visit (e.g. main house + guest house billed separately),
-- not a duplicate. Partial: jobs missing client_id or
-- scheduled_start_time (hand-created odd rows, pre-import legacy data)
-- fall outside it and always insert fresh -- acceptable, rare.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedup_key
  ON public.jobs (business_id, client_id, date, scheduled_start_time)
  WHERE client_id IS NOT NULL AND scheduled_start_time IS NOT NULL;

-- Schedule view's "Unassigned team" filter.
CREATE INDEX IF NOT EXISTS idx_jobs_team_code_raw
  ON public.jobs (business_id, team_code_raw)
  WHERE team IS NULL AND team_code_raw IS NOT NULL;

COMMENT ON COLUMN public.jobs.scheduled_start_time IS 'Precise time-typed scheduled start, from Maids import. Distinct from actual_start_at (GPS-derived real clock-in).';
COMMENT ON COLUMN public.jobs.scheduled_end_time IS 'Precise time-typed scheduled end, from Maids import. Distinct from actual_end_at (GPS-derived real clock-out).';
COMMENT ON COLUMN public.jobs.team_code_raw IS 'Original CSV team text when it did not map to a Penta team code (e.g. "Team Unassigned", "un", blank). team stays NULL in that case; Schedule view filters on this for manual assignment.';
COMMENT ON COLUMN public.jobs.is_multi_visit_day IS 'True on all jobs for a client+date when the client has 2+ scheduled visits that day (different start times) -- Maids sometimes bills main house + pool/guest house as separate jobs. Set by the importer, reviewed via the Double-billed clients tab, never auto-merged.';

-- ── clients ─────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS first_service_date              date,
  ADD COLUMN IF NOT EXISTS historical_cancellation_count    integer,
  ADD COLUMN IF NOT EXISTS historical_completion_count      integer,
  ADD COLUMN IF NOT EXISTS team_performance                 jsonb,
  ADD COLUMN IF NOT EXISTS current_price                    numeric,
  ADD COLUMN IF NOT EXISTS tags                              text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS review_flags                      text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_clients_tags ON public.clients USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_clients_review_flags ON public.clients USING gin (review_flags);

COMMENT ON COLUMN public.clients.tags IS 'Segment tags from Maids import: oms_only | past_client | recurring | past_client_marketing_target. Recomputed on every import run for clients touched by that run.';
COMMENT ON COLUMN public.clients.review_flags IS 'Manager-review flags, independent of tags: not_in_maids_import (existing Penta client absent from the latest import''s CSVs) | needs_address_details (sqft/room lookup failed). Cleared automatically when the condition resolves.';
COMMENT ON COLUMN public.clients.team_performance IS 'jsonb map of team code -> {avg_actual_quoted_ratio, job_count}, recomputed after each import from that team''s completed jobs for this client.';

-- ── import_runs ─────────────────────────────────────────────────────
CREATE TABLE public.import_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id               uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  run_by                    uuid REFERENCES public.users(id),
  run_at                    timestamptz NOT NULL DEFAULT now(),
  mode                      text NOT NULL CHECK (mode IN ('upsert', 'wipe')),
  csv_types_uploaded        text[] NOT NULL DEFAULT '{}',
  rows_processed            integer NOT NULL DEFAULT 0,
  clients_created           integer NOT NULL DEFAULT 0,
  clients_updated           integer NOT NULL DEFAULT 0,
  clients_flagged_review    integer NOT NULL DEFAULT 0,
  jobs_created              integer NOT NULL DEFAULT 0,
  jobs_updated              integer NOT NULL DEFAULT 0,
  jobs_flagged_multi_visit  integer NOT NULL DEFAULT 0,
  warnings_json             jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX idx_import_runs_business ON public.import_runs (business_id, run_at DESC);

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;

-- Same role gate as the RPC itself (owner/admin/manager) -- import is
-- an admin-only tool per the original spec, dispatchers can run the
-- schedule but not rewrite the client/job baseline.
CREATE POLICY import_runs_select ON public.import_runs
  FOR SELECT
  USING (
    auth_belongs_to_business(business_id)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager'))
  );

CREATE POLICY import_runs_insert ON public.import_runs
  FOR INSERT
  WITH CHECK (
    auth_belongs_to_business(business_id)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager'))
  );

-- ── import_maids_data RPC ───────────────────────────────────────────
-- SECURITY INVOKER: runs as the calling manager, under their own RLS —
-- no service-role/DEFINER tenant-boundary risk (see
-- feedback_security_definer_tenant_param memory). One call = one
-- Postgres transaction = the atomicity the client-side sequential
-- supabase-js calls can't give on their own.
--
-- Matching (which existing client a CSV row is) is ALREADY resolved by
-- the caller before this is invoked — p_clients_update carries the
-- Penta client `id` to update, p_clients_create is pure new rows. This
-- function does not do fuzzy matching itself.
CREATE OR REPLACE FUNCTION public.import_maids_data(
  p_business_id uuid,
  p_mode text,                 -- 'upsert' | 'wipe'
  p_csv_types text[],
  p_clients_update jsonb,      -- [{id, external_id, address, city, zip_code, frequency, tags}]
  p_clients_create jsonb,      -- [{external_id, first_name, last_name, address, city, zip_code, frequency, tags, status}]
  p_jobs jsonb                 -- [{client_external_id, date, scheduled_start_time, scheduled_end_time, team, team_code_raw, price, balance_due, quoted_minutes, actual_minutes, status, cancel_reason, cancellation_type, is_multi_visit_day}]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid;
  v_role public.user_role;
  v_clients_created int := 0;
  v_clients_updated int := 0;
  v_jobs_created int := 0;
  v_jobs_updated int := 0;
  v_clients_flagged int := 0;
  v_multi_visit int := 0;
  v_run_id uuid;
  v_touched_ids uuid[];
BEGIN
  SELECT id, role INTO v_caller_id, v_role
  FROM public.users WHERE id = auth.uid() AND business_id = p_business_id;

  IF v_caller_id IS NULL OR v_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'import_maids_data: caller not authorized for business %', p_business_id;
  END IF;

  IF p_mode NOT IN ('upsert', 'wipe') THEN
    RAISE EXCEPTION 'import_maids_data: invalid mode %', p_mode;
  END IF;

  IF p_mode = 'wipe' THEN
    DELETE FROM public.jobs WHERE business_id = p_business_id;
  END IF;

  -- Matched clients: update in place, keep their existing id.
  WITH upd AS (
    UPDATE public.clients c SET
      external_id = x.external_id,
      address     = COALESCE(x.address, c.address),
      city        = COALESCE(x.city, c.city),
      zip_code    = COALESCE(x.zip_code, c.zip_code),
      frequency   = COALESCE(x.frequency::public.frequency_code, c.frequency),
      tags        = x.tags,
      review_flags = array_remove(c.review_flags, 'not_in_maids_import'),
      updated_at  = now()
    FROM jsonb_to_recordset(COALESCE(p_clients_update, '[]'::jsonb)) AS x(
      id uuid, external_id text, address text, city text, zip_code text,
      frequency text, tags text[]
    )
    WHERE c.id = x.id AND c.business_id = p_business_id
    RETURNING c.id
  )
  SELECT count(*), COALESCE(array_agg(id), '{}'::uuid[]) INTO v_clients_updated, v_touched_ids FROM upd;

  -- New clients.
  WITH ins AS (
    INSERT INTO public.clients (
      business_id, external_id, first_name, last_name, address, city, zip_code,
      frequency, tags, status
    )
    SELECT
      p_business_id, x.external_id, x.first_name, x.last_name, x.address, x.city, x.zip_code,
      x.frequency::public.frequency_code, x.tags, x.status::public.client_status
    FROM jsonb_to_recordset(COALESCE(p_clients_create, '[]'::jsonb)) AS x(
      external_id text, first_name text, last_name text, address text, city text, zip_code text,
      frequency text, tags text[], status text
    )
    RETURNING id
  )
  SELECT count(*), v_touched_ids || COALESCE(array_agg(id), '{}'::uuid[])
    INTO v_clients_created, v_touched_ids
  FROM ins;
  -- (v_touched_ids is guaranteed non-null going into this step, seeded
  -- as '{}'::uuid[] above, so array || array here is always safe.)

  -- Jobs: upsert on the (business_id, client_id, date, scheduled_start_time)
  -- dedup key. client_id (text) targets clients.external_id, NOT
  -- clients.id — the same text/uuid split the rest of the app already
  -- uses (jobs.client_id -> clients.external_id).
  WITH job_src AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_jobs, '[]'::jsonb)) AS x(
      client_external_id text, date date,
      scheduled_start_time time, scheduled_end_time time,
      team text, team_code_raw text,
      price numeric, balance_due numeric,
      quoted_minutes integer, actual_minutes integer,
      status text, cancel_reason text, cancellation_type text,
      is_multi_visit_day boolean
    )
  ),
  updated AS (
    UPDATE public.jobs j SET
      time                 = to_char(s.scheduled_start_time, 'HH24:MI'),
      end_time             = to_char(s.scheduled_end_time, 'HH24:MI'),
      scheduled_start_time = s.scheduled_start_time,
      scheduled_end_time   = s.scheduled_end_time,
      team                 = s.team,
      team_code_raw        = s.team_code_raw,
      price                = s.price,
      balance_due          = s.balance_due,
      duration_minutes     = s.quoted_minutes,
      actual_minutes       = s.actual_minutes,
      status               = s.status,
      cancel_reason        = s.cancel_reason,
      cancellation_type    = s.cancellation_type,
      is_multi_visit_day   = s.is_multi_visit_day,
      updated_at           = now()
    FROM job_src s
    WHERE j.business_id = p_business_id
      AND j.client_id = s.client_external_id
      AND j.date = s.date
      AND j.scheduled_start_time IS NOT DISTINCT FROM s.scheduled_start_time
      AND s.scheduled_start_time IS NOT NULL
    RETURNING j.id, s.client_external_id, s.date, s.scheduled_start_time, s.is_multi_visit_day
  ),
  to_insert AS (
    SELECT s.* FROM job_src s
    LEFT JOIN updated u
      ON u.client_external_id = s.client_external_id
     AND u.date = s.date
     AND u.scheduled_start_time IS NOT DISTINCT FROM s.scheduled_start_time
    WHERE u.id IS NULL
  ),
  inserted AS (
    INSERT INTO public.jobs (
      business_id, client_id, date, time, end_time,
      scheduled_start_time, scheduled_end_time,
      team, team_code_raw, price, balance_due,
      duration_minutes, actual_minutes, status, cancel_reason,
      cancellation_type, is_multi_visit_day, created_by
    )
    SELECT
      p_business_id, client_external_id, date,
      to_char(scheduled_start_time, 'HH24:MI'), to_char(scheduled_end_time, 'HH24:MI'),
      scheduled_start_time, scheduled_end_time,
      team, team_code_raw, price, balance_due,
      quoted_minutes, actual_minutes, status, cancel_reason,
      cancellation_type, is_multi_visit_day, v_caller_id
    FROM to_insert
    RETURNING id, is_multi_visit_day
  )
  SELECT
    (SELECT count(*) FROM updated),
    (SELECT count(*) FROM inserted),
    (SELECT count(*) FROM updated WHERE is_multi_visit_day) + (SELECT count(*) FROM inserted WHERE is_multi_visit_day)
  INTO v_jobs_updated, v_jobs_created, v_multi_visit;

  -- Untouched-clients sweep: anyone in this business NOT covered by
  -- this run's client upsert gets flagged for the Import Review tab.
  -- (Only meaningful once at least one client array was non-empty —
  -- an empty-payload call, e.g. a jobs-only re-run, must not flag
  -- everyone.)
  IF v_touched_ids IS NOT NULL AND array_length(v_touched_ids, 1) > 0 THEN
    UPDATE public.clients c SET
      review_flags = array_append(c.review_flags, 'not_in_maids_import')
    WHERE c.business_id = p_business_id
      AND c.deleted_at IS NULL
      AND NOT (c.id = ANY(v_touched_ids))
      AND NOT ('not_in_maids_import' = ANY(c.review_flags));
    GET DIAGNOSTICS v_clients_flagged = ROW_COUNT;
  END IF;

  -- Derived data recompute — every client with at least one job on
  -- record for this business (broader than just this run's touched
  -- set, so a jobs-only re-run still keeps stats fresh).
  UPDATE public.clients c SET
    estimated_minutes = agg.est_min,
    current_price = agg.cur_price,
    first_service_date = agg.first_date,
    last_service_date = agg.last_completed_date,
    next_service_date = agg.next_future_date,
    historical_cancellation_count = agg.cancel_count,
    historical_completion_count = agg.complete_count,
    team_performance = agg.team_perf,
    updated_at = now()
  FROM (
    SELECT
      j.client_id AS ext_id,
      COALESCE(
        percentile_cont(0.5) WITHIN GROUP (ORDER BY j.actual_minutes)
          FILTER (WHERE j.status = 'completed' AND j.actual_minutes IS NOT NULL AND j.date >= (current_date - interval '12 months')),
        percentile_cont(0.5) WITHIN GROUP (ORDER BY j.duration_minutes)
          FILTER (WHERE j.duration_minutes IS NOT NULL AND j.date >= (current_date - interval '12 months'))
      )::int AS est_min,
      (array_agg(j.price ORDER BY j.date DESC, j.scheduled_start_time DESC NULLS LAST) FILTER (WHERE j.price IS NOT NULL))[1] AS cur_price,
      min(j.date) AS first_date,
      max(j.date) FILTER (WHERE j.status = 'completed') AS last_completed_date,
      min(j.date) FILTER (WHERE j.status = 'scheduled' AND j.date >= current_date) AS next_future_date,
      count(*) FILTER (WHERE j.status = 'cancelled' AND j.cancellation_type = 'client_initiated' AND j.date >= (current_date - interval '12 months')) AS cancel_count,
      count(*) FILTER (WHERE j.status = 'completed' AND j.date >= (current_date - interval '12 months')) AS complete_count,
      jsonb_object_agg(tp.team, jsonb_build_object('avg_actual_quoted_ratio', tp.ratio, 'job_count', tp.n))
        FILTER (WHERE tp.team IS NOT NULL) AS team_perf
    FROM public.jobs j
    LEFT JOIN LATERAL (
      SELECT j2.team,
             round(avg(j2.actual_minutes::numeric / NULLIF(j2.duration_minutes, 0)), 3) AS ratio,
             count(*) AS n
      FROM public.jobs j2
      WHERE j2.business_id = p_business_id
        AND j2.client_id = j.client_id
        AND j2.team IS NOT NULL
        AND j2.status = 'completed'
        AND j2.actual_minutes IS NOT NULL
        AND j2.duration_minutes IS NOT NULL
        AND j2.duration_minutes > 0
      GROUP BY j2.team
    ) tp ON tp.team = j.team
    WHERE j.business_id = p_business_id AND j.client_id IS NOT NULL
    GROUP BY j.client_id
  ) agg
  WHERE c.business_id = p_business_id AND c.external_id = agg.ext_id;

  INSERT INTO public.import_runs (
    business_id, run_by, mode, csv_types_uploaded, rows_processed,
    clients_created, clients_updated, clients_flagged_review,
    jobs_created, jobs_updated, jobs_flagged_multi_visit
  ) VALUES (
    p_business_id, v_caller_id, p_mode, COALESCE(p_csv_types, '{}'),
    COALESCE(jsonb_array_length(p_jobs), 0),
    v_clients_created, v_clients_updated, v_clients_flagged,
    v_jobs_created, v_jobs_updated, v_multi_visit
  ) RETURNING id INTO v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'clients_created', v_clients_created,
    'clients_updated', v_clients_updated,
    'clients_flagged_review', v_clients_flagged,
    'jobs_created', v_jobs_created,
    'jobs_updated', v_jobs_updated,
    'jobs_flagged_multi_visit', v_multi_visit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_maids_data(uuid, text, text[], jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_maids_data(uuid, text, text[], jsonb, jsonb, jsonb) TO authenticated;
