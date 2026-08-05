-- PR #97 — the two items flagged (not fixed) in PR #96's diagnosis.
--
-- ITEM A: repair the 8 orphaned job rows found live in the
-- 2026-08-05 wipe-mode import, root-caused in index.html's
-- maidsBuildPreview/maidsBuildPayload (see the code comments there
-- for the full mechanism — a group's jobs used to get
-- client_external_id from the group's OWN first-row Customer ID/key,
-- computed independently of maidsMatchClient's actual match result;
-- when a matched EXISTING client's real external_id differed from
-- that group key, the client record updated fine but its jobs
-- attached to nothing).
--
-- Repair approach: create a client row for each of the 4 orphaned
-- external_ids so the jobs are attached and operationally visible
-- (one of them — 10956520 — has a job scheduled for TODAY) rather
-- than either left silently invisible or guessed onto the WRONG
-- existing client. The source CSVs aren't stored server-side (client-
-- side-only import), so there is no way to recover these 4 people's
-- real name/address from here — every stub is explicitly flagged
-- 'unidentified_import_customer' with a job summary in notes so Tom
-- can identify and merge/rename each one manually. No guess made.
--
-- ITEM B: import_maids_finish gains p_warnings (default '[]' so old
-- callers — none exist post-deploy, but defensive — don't break) and
-- now persists it to import_runs.warnings_json, which existed but was
-- never written to. index.html's maidsRunCommitBatched now passes
-- preview.warnings (already computed, previously discarded) through.

INSERT INTO public.clients (business_id, external_id, first_name, last_name, status, review_flags, notes)
VALUES
  ('48532f06-0625-415b-9091-2638bed6506d', '10851645', 'Unidentified', 'Maids #10851645', 'active',
   ARRAY['unidentified_import_customer'],
   '⚠️ Created by PR #97 to repair an orphaned import row (Maids customer ID 10851645 matched an existing client during the 2026-08-05 import, so no new client was created then, but its jobs never got attached to anything). 1 job: 2025-08-08 cancelled, $0. The real name/address weren''t recoverable — the source CSV isn''t stored server-side. If you recognize this job, merge into the real client and delete this stub; otherwise it''s safe to leave or remove.'),
  ('48532f06-0625-415b-9091-2638bed6506d', '10875330', 'Unidentified', 'Maids #10875330', 'active',
   ARRAY['unidentified_import_customer'],
   '⚠️ Created by PR #97 to repair 4 orphaned import rows (Maids customer ID 10875330). Jobs: 2025-10-03 cancelled $0 (team B5), 2025-10-15 completed $390 (team B5), 2026-05-07 completed $600 (team B1), 2026-06-16 cancelled $0 (team B3). The real name/address weren''t recoverable — the source CSV isn''t stored server-side. If you recognize this pattern, merge into the real client and delete this stub; otherwise it''s safe to leave or remove.'),
  ('48532f06-0625-415b-9091-2638bed6506d', '10906649', 'Unidentified', 'Maids #10906649', 'active',
   ARRAY['unidentified_import_customer'],
   '⚠️ Created by PR #97 to repair an orphaned import row (Maids customer ID 10906649). 1 job: 2026-01-02 cancelled, $0 (team B1). The real name/address weren''t recoverable — the source CSV isn''t stored server-side. If you recognize this job, merge into the real client and delete this stub; otherwise it''s safe to leave or remove.'),
  ('48532f06-0625-415b-9091-2638bed6506d', '10956520', 'Unidentified', 'Maids #10956520', 'active',
   ARRAY['unidentified_import_customer'],
   '⚠️ Created by PR #97 to repair 2 orphaned import rows (Maids customer ID 10956520). Jobs: 2026-05-14 completed $541 (team S1), 2026-08-05 SCHEDULED $541 (team S1) — this one has a live appointment today. The real name/address weren''t recoverable — the source CSV isn''t stored server-side. Identify this client before today''s appointment if possible; otherwise the job is still correctly on the schedule under this stub.');

-- These 4 stubs didn't exist yet when the original 2026-08-05 import
-- ran its derived-stat recompute (import_maids_finish), so their
-- historical_completion_count/first_service_date/etc would otherwise
-- sit blank forever. Same aggregation import_maids_finish itself
-- runs, scoped to just these 4 external_ids.
UPDATE public.clients c SET
  current_price = agg.cur_price,
  first_service_date = agg.first_date,
  last_service_date = agg.last_completed_date,
  next_service_date = agg.next_future_date,
  historical_cancellation_count = agg.cancel_count,
  historical_completion_count = agg.complete_count,
  updated_at = now()
FROM (
  SELECT
    j.client_id AS ext_id,
    (array_agg(j.price ORDER BY j.date DESC, j.scheduled_start_time DESC NULLS LAST) FILTER (WHERE j.price IS NOT NULL))[1] AS cur_price,
    min(j.date) AS first_date,
    max(j.date) FILTER (WHERE j.status = 'completed') AS last_completed_date,
    min(j.date) FILTER (WHERE j.status = 'scheduled' AND j.date >= current_date) AS next_future_date,
    count(*) FILTER (WHERE j.status = 'cancelled' AND j.date >= (current_date - interval '12 months')) AS cancel_count,
    count(*) FILTER (WHERE j.status = 'completed' AND j.date >= (current_date - interval '12 months')) AS complete_count
  FROM public.jobs j
  WHERE j.business_id = '48532f06-0625-415b-9091-2638bed6506d'
    AND j.client_id IN ('10851645','10875330','10906649','10956520')
  GROUP BY j.client_id
) agg
WHERE c.business_id = '48532f06-0625-415b-9091-2638bed6506d' AND c.external_id = agg.ext_id;

-- CREATE OR REPLACE does NOT replace a function whose signature
-- changed (adding a parameter makes it a distinct overload in
-- Postgres) -- it leaves the old one in place alongside the new one.
-- Drop the old 6-arg version explicitly so there's exactly one
-- import_maids_finish again; two overloads risked a PostgREST
-- "could not choose the best candidate function" ambiguity error on
-- any caller still matching the old arg list.
DROP FUNCTION IF EXISTS public.import_maids_finish(uuid, uuid, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.import_maids_finish(
  p_business_id uuid, p_run_id uuid, p_rows_processed integer,
  p_jobs_created integer, p_jobs_updated integer, p_jobs_flagged_multi_visit integer,
  p_warnings jsonb DEFAULT '[]'::jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    jobs_flagged_multi_visit = p_jobs_flagged_multi_visit,
    warnings_json = COALESCE(p_warnings, '[]'::jsonb)
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
    'warnings', v_run.warnings_json,
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
$function$;
