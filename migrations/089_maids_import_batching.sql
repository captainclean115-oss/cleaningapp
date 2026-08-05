-- 089 — Maids importer batching (PR #81).
--
-- Tom's first full-data commit attempt (~14,064 jobs) hit "canceling
-- statement due to statement timeout." The `authenticated` role has
-- statement_timeout=8s configured at the role level (confirmed live via
-- pg_roles.rolconfig -- not Postgres's 60s-ish generic default Tom
-- assumed). import_maids_data did client upsert + full job upsert +
-- derived-stat recompute + review-flag sweep in ONE statement/
-- transaction -- benchmarked at full scale (14,000 synthetic jobs,
-- under SET ROLE authenticated so RLS is actually enforced): ~4.3s for
-- the job upsert CTE chain alone (trigger + RLS included), ~0.8s for
-- the derived-stat recompute. Neither piece alone blows 8s; summed in
-- one statement, they comfortably do.
--
-- Fix: split into three RPCs, orchestrated client-side in sequence.
-- Each call is its own transaction, well under 8s even under load:
--   1. import_maids_start   -- wipe (if any) + client upsert + review-
--                               flag sweep + provisional import_runs
--                               row. ~900 clients, one call.
--   2. import_maids_jobs_batch -- job upsert for ONE batch (JS chunks
--                               into 500-row slices). Idempotent --
--                               safe to re-call the same batch if a
--                               retry re-sends it. ~150ms/batch at
--                               500 rows per the same benchmark.
--   3. import_maids_finish   -- derived-stat recompute (once, not per
--                               batch -- was previously accidentally
--                               free to run once anyway, no need to
--                               pay for it 29 times) + import_runs
--                               final totals.
--
-- import_maids_data (migration 087/088) is dropped -- nothing calls it
-- after this ships, and an unbatched RPC that reliably times out on
-- real data is a footgun to leave lying around.

DROP FUNCTION IF EXISTS public.import_maids_data(uuid, text, text[], jsonb, jsonb, jsonb);

-- import_runs (migration 087) only ever got SELECT/INSERT policies --
-- import_maids_finish needs to UPDATE the provisional row with final
-- totals, and RLS defaults to zero-row-match (not an error) for a
-- command with no permissive policy. Caught live: the first rolled-
-- back batched test returned a run_id of null from finish because the
-- UPDATE silently touched nothing.
CREATE POLICY import_runs_update ON public.import_runs
  FOR UPDATE
  USING (
    auth_belongs_to_business(business_id)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner','admin','manager'))
  );

-- ── import_maids_start ─────────────────────────────────────────────
-- Wipe (danger-zone toggle, off by default) + client upsert + the
-- untouched-clients review-flag sweep (depends only on the client
-- lists, not on jobs, so it belongs here rather than in finish) +
-- reserves the run id up front so every job batch and the finish call
-- can reference it.
CREATE OR REPLACE FUNCTION public.import_maids_start(
  p_business_id uuid,
  p_mode text,                 -- 'upsert' | 'wipe'
  p_csv_types text[],
  p_clients_update jsonb,      -- [{id, external_id, address, city, zip_code, frequency, tags}]
  p_clients_create jsonb       -- [{external_id, first_name, last_name, address, city, zip_code, frequency, tags, status}]
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
  v_clients_flagged int := 0;
  v_run_id uuid := gen_random_uuid();
  v_touched_ids uuid[];
BEGIN
  SELECT id, role INTO v_caller_id, v_role
  FROM public.users WHERE id = auth.uid() AND business_id = p_business_id;

  IF v_caller_id IS NULL OR v_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'import_maids_start: caller not authorized for business %', p_business_id;
  END IF;

  IF p_mode NOT IN ('upsert', 'wipe') THEN
    RAISE EXCEPTION 'import_maids_start: invalid mode %', p_mode;
  END IF;

  IF p_mode = 'wipe' THEN
    DELETE FROM public.jobs WHERE business_id = p_business_id;
  END IF;

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

  IF v_touched_ids IS NOT NULL AND array_length(v_touched_ids, 1) > 0 THEN
    UPDATE public.clients c SET
      review_flags = array_append(c.review_flags, 'not_in_maids_import')
    WHERE c.business_id = p_business_id
      AND c.deleted_at IS NULL
      AND NOT (c.id = ANY(v_touched_ids))
      AND NOT ('not_in_maids_import' = ANY(c.review_flags));
    GET DIAGNOSTICS v_clients_flagged = ROW_COUNT;
  END IF;

  -- Provisional row -- job counts/rows_processed are filled in by
  -- import_maids_finish once every batch has landed.
  INSERT INTO public.import_runs (
    id, business_id, run_by, mode, csv_types_uploaded, rows_processed,
    clients_created, clients_updated, clients_flagged_review,
    jobs_created, jobs_updated, jobs_flagged_multi_visit
  ) VALUES (
    v_run_id, p_business_id, v_caller_id, p_mode, COALESCE(p_csv_types, '{}'),
    0, v_clients_created, v_clients_updated, v_clients_flagged, 0, 0, 0
  );

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'clients_created', v_clients_created,
    'clients_updated', v_clients_updated,
    'clients_flagged_review', v_clients_flagged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_maids_start(uuid, text, text[], jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_maids_start(uuid, text, text[], jsonb, jsonb) TO authenticated;

-- ── import_maids_jobs_batch ────────────────────────────────────────
-- One batch of jobs (JS chunks into 500-row slices). Idempotent: an
-- upsert on the existing (business_id, client_id, date,
-- scheduled_start_time) dedup key, so re-sending an already-succeeded
-- batch on retry is harmless -- it just re-updates the same rows to
-- the same values. This is what makes client-side "resume from the
-- failed batch, don't touch what already landed" safe by construction
-- rather than something the client has to get exactly right.
CREATE OR REPLACE FUNCTION public.import_maids_jobs_batch(
  p_business_id uuid,
  p_run_id uuid,
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
  v_jobs_created int := 0;
  v_jobs_updated int := 0;
  v_multi_visit int := 0;
  v_duplicates int := 0;
BEGIN
  SELECT id, role INTO v_caller_id, v_role
  FROM public.users WHERE id = auth.uid() AND business_id = p_business_id;

  IF v_caller_id IS NULL OR v_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'import_maids_jobs_batch: caller not authorized for business %', p_business_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.import_runs WHERE id = p_run_id AND business_id = p_business_id) THEN
    RAISE EXCEPTION 'import_maids_jobs_batch: run % not found for business %', p_run_id, p_business_id;
  END IF;

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
    p_business_id, p_run_id, j.id, d.client_external_id, d.date,
    d.scheduled_start_time_original, d.scheduled_start_time,
    COALESCE(d.adjustment_minutes, 0), COALESCE(d.adjustment_minutes, 0) = 0
  FROM dup_src d
  JOIN public.jobs j
    ON j.business_id = p_business_id
   AND j.client_id = d.client_external_id
   AND j.date = d.date
   AND j.scheduled_start_time IS NOT DISTINCT FROM d.scheduled_start_time;
  GET DIAGNOSTICS v_duplicates = ROW_COUNT;

  RETURN jsonb_build_object(
    'jobs_created', v_jobs_created,
    'jobs_updated', v_jobs_updated,
    'jobs_flagged_multi_visit', v_multi_visit,
    'duplicates_detected', v_duplicates
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_maids_jobs_batch(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_maids_jobs_batch(uuid, uuid, jsonb) TO authenticated;

-- ── import_maids_finish ────────────────────────────────────────────
-- Derived-stat recompute (once -- not per batch; the previous
-- single-transaction RPC only paid for this once too, so batching
-- doesn't change its cost, it just moves it to its own call) +
-- writes the run's final totals (accumulated client-side across every
-- batch response, passed in here) + returns the full summary jsonb
-- the import summary screen renders.
CREATE OR REPLACE FUNCTION public.import_maids_finish(
  p_business_id uuid,
  p_run_id uuid,
  p_rows_processed int,
  p_jobs_created int,
  p_jobs_updated int,
  p_jobs_flagged_multi_visit int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid;
  v_role public.user_role;
  v_run public.import_runs;
BEGIN
  SELECT id, role INTO v_caller_id, v_role
  FROM public.users WHERE id = auth.uid() AND business_id = p_business_id;

  IF v_caller_id IS NULL OR v_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'import_maids_finish: caller not authorized for business %', p_business_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.import_runs WHERE id = p_run_id AND business_id = p_business_id) THEN
    RAISE EXCEPTION 'import_maids_finish: run % not found for business %', p_run_id, p_business_id;
  END IF;

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

  UPDATE public.import_runs SET
    rows_processed = p_rows_processed,
    jobs_created = p_jobs_created,
    jobs_updated = p_jobs_updated,
    jobs_flagged_multi_visit = p_jobs_flagged_multi_visit
  WHERE id = p_run_id AND business_id = p_business_id
  RETURNING * INTO v_run;

  RETURN jsonb_build_object(
    'run_id', v_run.id,
    'clients_created', v_run.clients_created,
    'clients_updated', v_run.clients_updated,
    'clients_flagged_review', v_run.clients_flagged_review,
    'jobs_created', v_run.jobs_created,
    'jobs_updated', v_run.jobs_updated,
    'jobs_flagged_multi_visit', v_run.jobs_flagged_multi_visit,
    'duplicates_detected', (SELECT count(*) FROM public.maids_import_duplicates WHERE import_run_id = p_run_id),
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
      WHERE import_run_id = p_run_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_maids_finish(uuid, uuid, int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_maids_finish(uuid, uuid, int, int, int, int) TO authenticated;
