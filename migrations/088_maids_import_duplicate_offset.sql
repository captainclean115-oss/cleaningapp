-- 088 — Maids importer "Option D": same-time multi-visit duplicates (PR #80).
--
-- Tom's real data hits jobs_dedup_key (business_id, client_id, date,
-- scheduled_start_time) on legitimate cases: main house + in-law/pool/
-- guest house billed as separate jobs at the exact same nominal start
-- time. These are real revenue, not data-entry duplicates -- do not
-- skip or merge them.
--
-- Fix: the importer (client-side, maidsBuildPreview) now detects any
-- group of jobs sharing (client_external_id, date, start_time) BEFORE
-- calling this RPC, and bumps every member after the first by 1 more
-- minute (2nd = +1, 3rd = +2, ...), sorted by the CSV's Job Reference
-- for a stable, re-import-safe order. By the time p_jobs reaches this
-- RPC, every job already has a unique dedup key -- this migration adds
-- the columns/table to persist what happened, not any new dedup logic
-- in SQL itself.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS scheduled_start_time_adjusted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scheduled_start_time_original  time;

COMMENT ON COLUMN public.jobs.scheduled_start_time_adjusted IS 'True when the importer bumped this job''s start time by 1+ minutes to resolve a same-time multi-visit collision. scheduled_start_time is the adjusted value actually used everywhere; scheduled_start_time_original has the raw pre-adjustment time.';
COMMENT ON COLUMN public.jobs.scheduled_start_time_original IS 'Raw start time from the CSV before any multi-visit-collision adjustment. NULL unless this job was part of a same-time duplicate group (whether or not IT was the one bumped -- the group''s one unbumped member also gets this set, to the same value as scheduled_start_time, for audit symmetry).';

-- ── maids_import_duplicates ────────────────────────────────────────
-- import_run_id's FK is DEFERRABLE INITIALLY DEFERRED: the RPC inserts
-- these tracking rows against a pre-reserved v_run_id BEFORE the
-- actual import_runs row is written (that insert happens last, after
-- derived-stat recompute) -- an immediate FK check would fail every
-- single import. Deferred defers the check to COMMIT, by which point
-- the import_runs row exists.
CREATE TABLE public.maids_import_duplicates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  import_run_id        uuid REFERENCES public.import_runs(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  job_id               uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  client_id            text NOT NULL,
  service_date         date NOT NULL,
  original_start_time  time NOT NULL,
  adjusted_start_time  time NOT NULL,
  adjustment_minutes   integer NOT NULL DEFAULT 0,
  kept_original_time   boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_maids_import_duplicates_run ON public.maids_import_duplicates (import_run_id);
CREATE INDEX idx_maids_import_duplicates_business ON public.maids_import_duplicates (business_id, service_date);

ALTER TABLE public.maids_import_duplicates ENABLE ROW LEVEL SECURITY;

CREATE POLICY maids_import_duplicates_select ON public.maids_import_duplicates
  FOR SELECT
  USING (
    auth_belongs_to_business(business_id)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager'))
  );

CREATE POLICY maids_import_duplicates_insert ON public.maids_import_duplicates
  FOR INSERT
  WITH CHECK (
    auth_belongs_to_business(business_id)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager'))
  );

COMMENT ON TABLE public.maids_import_duplicates IS 'One row per member of a same-(client,date,start_time) group the importer resolved by offsetting start times. kept_original_time=true identifies the one member of each group that kept its raw CSV time (adjustment_minutes=0); the rest were bumped. Surfaced on the import summary screen as "N same-time multi-visits detected."';

-- ── import_maids_data RPC — accept + persist the new per-job fields ──
-- Signature unchanged (still 6 params, new fields ride inside the
-- existing p_jobs jsonb) -- CREATE OR REPLACE, no DROP needed.
--
-- v_run_id is now reserved via gen_random_uuid() up front (instead of
-- RETURNING id INTO at the very end) so the maids_import_duplicates
-- insert, which needs it, can happen before the import_runs row itself
-- is written.
CREATE OR REPLACE FUNCTION public.import_maids_data(
  p_business_id uuid,
  p_mode text,                 -- 'upsert' | 'wipe'
  p_csv_types text[],
  p_clients_update jsonb,      -- [{id, external_id, address, city, zip_code, frequency, tags}]
  p_clients_create jsonb,      -- [{external_id, first_name, last_name, address, city, zip_code, frequency, tags, status}]
  p_jobs jsonb                 -- [{client_external_id, date, scheduled_start_time, scheduled_end_time, scheduled_start_time_original, scheduled_start_time_adjusted, duplicate_group, adjustment_minutes, team, team_code_raw, price, balance_due, quoted_minutes, actual_minutes, status, cancel_reason, cancellation_type, is_multi_visit_day}]
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
  v_duplicates int := 0;
  v_run_id uuid := gen_random_uuid();
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

  -- Jobs: upsert on the (business_id, client_id, date, scheduled_start_time)
  -- dedup key. By this point every job in p_jobs already has a unique
  -- key -- the caller (maidsBuildPreview) resolved same-time collisions
  -- by offsetting start times before building this payload.
  WITH job_src AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_jobs, '[]'::jsonb)) AS x(
      client_external_id text, date date,
      scheduled_start_time time, scheduled_end_time time,
      scheduled_start_time_original time, scheduled_start_time_adjusted boolean,
      team text, team_code_raw text,
      price numeric, balance_due numeric,
      quoted_minutes integer, actual_minutes integer,
      status text, cancel_reason text, cancellation_type text,
      is_multi_visit_day boolean
    )
  ),
  updated AS (
    UPDATE public.jobs j SET
      time                          = to_char(s.scheduled_start_time, 'HH24:MI'),
      end_time                      = to_char(s.scheduled_end_time, 'HH24:MI'),
      scheduled_start_time          = s.scheduled_start_time,
      scheduled_end_time            = s.scheduled_end_time,
      scheduled_start_time_original = s.scheduled_start_time_original,
      scheduled_start_time_adjusted = COALESCE(s.scheduled_start_time_adjusted, false),
      team                          = s.team,
      team_code_raw                 = s.team_code_raw,
      price                         = s.price,
      balance_due                   = s.balance_due,
      duration_minutes              = s.quoted_minutes,
      actual_minutes                = s.actual_minutes,
      status                        = s.status,
      cancel_reason                 = s.cancel_reason,
      cancellation_type             = s.cancellation_type,
      is_multi_visit_day            = s.is_multi_visit_day,
      updated_at                    = now()
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
      scheduled_start_time_original, scheduled_start_time_adjusted,
      team, team_code_raw, price, balance_due,
      duration_minutes, actual_minutes, status, cancel_reason,
      cancellation_type, is_multi_visit_day, created_by
    )
    SELECT
      p_business_id, client_external_id, date,
      to_char(scheduled_start_time, 'HH24:MI'), to_char(scheduled_end_time, 'HH24:MI'),
      scheduled_start_time, scheduled_end_time,
      scheduled_start_time_original, COALESCE(scheduled_start_time_adjusted, false),
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

  -- Multi-visit duplicate tracking: one row per group member (both the
  -- one that kept its original time and the ones that got bumped),
  -- looked up by the now-final natural key rather than threaded through
  -- RETURNING, since duplicate_group/adjustment_minutes aren't
  -- persisted job columns.
  WITH dup_src AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_jobs, '[]'::jsonb)) AS x(
      client_external_id text, date date, scheduled_start_time time,
      scheduled_start_time_original time, adjustment_minutes integer,
      duplicate_group boolean
    )
    WHERE COALESCE(duplicate_group, false)
  )
  INSERT INTO public.maids_import_duplicates (
    business_id, import_run_id, job_id, client_id, service_date,
    original_start_time, adjusted_start_time, adjustment_minutes, kept_original_time
  )
  SELECT
    p_business_id, v_run_id, j.id, d.client_external_id, d.date,
    d.scheduled_start_time_original, d.scheduled_start_time,
    COALESCE(d.adjustment_minutes, 0), COALESCE(d.adjustment_minutes, 0) = 0
  FROM dup_src d
  JOIN public.jobs j
    ON j.business_id = p_business_id
   AND j.client_id = d.client_external_id
   AND j.date = d.date
   AND j.scheduled_start_time IS NOT DISTINCT FROM d.scheduled_start_time;
  GET DIAGNOSTICS v_duplicates = ROW_COUNT;

  -- Untouched-clients sweep: anyone in this business NOT covered by
  -- this run's client upsert gets flagged for the Import Review tab.
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
    id, business_id, run_by, mode, csv_types_uploaded, rows_processed,
    clients_created, clients_updated, clients_flagged_review,
    jobs_created, jobs_updated, jobs_flagged_multi_visit
  ) VALUES (
    v_run_id, p_business_id, v_caller_id, p_mode, COALESCE(p_csv_types, '{}'),
    COALESCE(jsonb_array_length(p_jobs), 0),
    v_clients_created, v_clients_updated, v_clients_flagged,
    v_jobs_created, v_jobs_updated, v_multi_visit
  );

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'clients_created', v_clients_created,
    'clients_updated', v_clients_updated,
    'clients_flagged_review', v_clients_flagged,
    'jobs_created', v_jobs_created,
    'jobs_updated', v_jobs_updated,
    'jobs_flagged_multi_visit', v_multi_visit,
    'duplicates_detected', v_duplicates,
    'duplicates', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'client_id', client_id,
        'service_date', service_date,
        'original_start_time', to_char(original_start_time, 'HH24:MI'),
        'adjusted_start_time', to_char(adjusted_start_time, 'HH24:MI'),
        'adjustment_minutes', adjustment_minutes,
        'kept_original_time', kept_original_time
      ) ORDER BY service_date, client_id, adjustment_minutes), '[]'::jsonb)
      FROM public.maids_import_duplicates
      WHERE import_run_id = v_run_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_maids_data(uuid, text, text[], jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_maids_data(uuid, text, text[], jsonb, jsonb, jsonb) TO authenticated;
