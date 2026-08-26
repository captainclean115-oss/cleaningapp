-- PR #146 — rolling 12-month recurring (RMS) schedule projection.
--
-- Context: autoGenerateSchedule() (index.html) turned out to be dead code --
-- its only trigger condition (jobs.fromSheets, a legacy Google-Sheets sync
-- path) can never be true in the current Supabase-backed app, so it always
-- no-ops. This migration adds a real, server-side, incremental projection
-- engine instead of extending that dead function.
--
-- Scope decisions made explicit after investigation (grepped, not guessed):
--   - Frequency -> day-interval mapping is confirmed from the DB enum and
--     existing in-app usage (buildSchedule, FREQ_SORT_DAYS): RMS-WEK=7,
--     RMS-EOW=14, RMS-ETW=21 ("every 3 weeks" -- 11 real clients use this
--     tier), RMS-EFW=28 (labeled "Monthly+" in the existing UI), RMS-MON=28
--     (standardized to 28, not the 30 one pre-existing sort-order table
--     uses elsewhere -- 28 is required for day-of-week-preserving snapping;
--     that other table's drift is a separate, out-of-scope pre-existing
--     inconsistency, not touched here).
--   - clients.preferred_team_id exists but is completely unwired (no UI,
--     zero clients have it set) -- this migration adds read support for it
--     (resolved via teams.id -> teams.name, which already matches jobs.team
--     text values 1:1) with a fallback to the client's most-recently
--     completed job's team, per explicit instruction. No new client-editor
--     UI is added for setting it.
--   - "Do not touch existing jobs": this engine only ever INSERTs. It never
--     UPDATEs or DELETEs a jobs row. The existing Maids-CSV-imported
--     schedule (through 2026-12-31) is left completely alone; new rows
--     only land on dates that don't already have a job for that client
--     (exact-date dedup, PLUS a same-cycle-window dedup so a manually
--     rescheded job a day or two off the anchor date doesn't get duplicated
--     -- see the reschedule-detection comment on project_recurring_jobs_for_business).

-- ═══════════════════════════════════════════════════════════════
-- 1. Schema: distinguish auto-projected jobs from manually-created ones
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.jobs
  ADD COLUMN projection_source text NOT NULL DEFAULT 'manual'
    CHECK (projection_source IN ('manual', 'auto_projected'));

COMMENT ON COLUMN public.jobs.projection_source IS
  'manual = created by a person (including the Maids CSV import) or any '
  'existing pre-migration row. auto_projected = created by '
  'project_recurring_jobs_for_business(). Distinct from auto_generated '
  '(legacy client-side flag, PR #1-era) -- this column is the source of '
  'truth for the new server-side engine specifically.';

-- ═══════════════════════════════════════════════════════════════
-- 2. Canonical frequency -> interval-in-days mapping.
--    Single source of truth so the projection engine and the
--    cadence-drift report never diverge (this codebase has a documented
--    history of exactly that bug class across 4+ independently-typed
--    copies of this same mapping in index.html).
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.recurring_interval_days(p_frequency text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_frequency
    WHEN 'RMS-WEK' THEN 7
    WHEN 'RMS-EOW' THEN 14
    WHEN 'RMS-ETW' THEN 21
    WHEN 'RMS-EFW' THEN 28
    WHEN 'RMS-MON' THEN 28
    ELSE NULL
  END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- 3. Core engine -- INSERT-only, per-business, idempotent.
--    NOT exposed to PostgREST/authenticated callers directly (see grants
--    at the bottom): a bare p_business_id parameter with no caller-identity
--    check would be a cross-tenant hole (this project's own standing
--    guidance -- SECURITY DEFINER + a caller-suppliable business_id is
--    exactly the shape of that risk). Only reachable via the two wrapper
--    functions below, which resolve business_id from the caller's own
--    identity (project_recurring_jobs_now) or loop every tenant
--    (trigger_project_recurring_jobs_all_tenants, cron-only).
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.project_recurring_jobs_for_business(
  p_business_id uuid,
  p_as_of date DEFAULT current_date,
  p_window_months integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_client         record;
  v_interval_days  integer;
  v_window_end     date;
  v_k_start        integer;
  v_date           date;
  v_half_interval  integer;
  v_team           text;
  v_clients_processed integer := 0;
  v_jobs_created       integer := 0;
  v_errors             jsonb := '[]'::jsonb;
BEGIN
  v_window_end := (p_as_of + (p_window_months || ' months')::interval)::date;

  FOR v_client IN
    SELECT c.id, c.external_id, c.anchor_date, c.frequency,
           c.preferred_team_id, c.current_price, c.estimated_minutes
    FROM public.clients c
    WHERE c.business_id = p_business_id
      AND c.status = 'active'
      AND c.frequency IS NOT NULL
      AND c.frequency <> 'OMS'
      AND c.anchor_date IS NOT NULL
  LOOP
    BEGIN
      v_clients_processed := v_clients_processed + 1;
      v_interval_days := public.recurring_interval_days(v_client.frequency::text);
      IF v_interval_days IS NULL THEN
        -- Unrecognized frequency code -- shouldn't happen given the enum,
        -- but fail loud into the summary rather than silently skip.
        v_errors := v_errors || jsonb_build_object(
          'client_external_id', v_client.external_id,
          'error', 'unrecognized frequency: ' || v_client.frequency
        );
        CONTINUE;
      END IF;
      v_half_interval := v_interval_days / 2; -- integer division, e.g. 7 for EOW

      -- First anchor-aligned cycle date on/after p_as_of. Always computed
      -- from the ORIGINAL anchor_date + k*interval -- never re-derived from
      -- any existing job's actual date, which is what guarantees a manual
      -- reschedule never shifts subsequent projected dates (rule 4).
      v_k_start := GREATEST(0, CEIL((p_as_of - v_client.anchor_date)::numeric / v_interval_days));
      v_date := v_client.anchor_date + (v_k_start * v_interval_days);

      WHILE v_date <= v_window_end LOOP
        IF EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.business_id = p_business_id
            AND j.client_id = v_client.external_id
            AND j.date = v_date
        ) THEN
          -- Rule 5: exact-date job already exists (CSV import, manual entry,
          -- or a prior projection run) -- never duplicate.
          NULL;
        ELSIF EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.business_id = p_business_id
            AND j.client_id = v_client.external_id
            AND j.date <> v_date
            AND j.date BETWEEN (v_date - v_half_interval) AND (v_date + v_half_interval)
        ) THEN
          -- Rule 4: a job exists elsewhere in this cycle's window (a manual
          -- reschedule off the anchor day-of-week) -- this cycle is already
          -- covered. Do NOT insert at v_date, and critically do NOT re-base
          -- future iterations off the rescheduled date -- v_date next loop
          -- iteration is still anchor_date + (k+1)*interval_days regardless.
          NULL;
        ELSE
          -- Team: client's own preferred_team_id first, else fall back to
          -- their most recent completed job's team, else NULL (admin assigns).
          v_team := NULL;
          IF v_client.preferred_team_id IS NOT NULL THEN
            SELECT t.name INTO v_team
            FROM public.teams t
            WHERE t.id = v_client.preferred_team_id
              AND t.business_id = p_business_id;
          END IF;
          IF v_team IS NULL THEN
            SELECT j.team INTO v_team
            FROM public.jobs j
            WHERE j.business_id = p_business_id
              AND j.client_id = v_client.external_id
              AND j.status = 'completed'
              AND j.team IS NOT NULL
            ORDER BY j.date DESC
            LIMIT 1;
          END IF;

          INSERT INTO public.jobs (
            business_id, client_id, date, team, price, duration_minutes,
            status, auto_generated, projection_source
          ) VALUES (
            p_business_id, v_client.external_id, v_date, v_team,
            v_client.current_price, v_client.estimated_minutes,
            'scheduled', true, 'auto_projected'
          );
          v_jobs_created := v_jobs_created + 1;
        END IF;

        v_date := v_date + v_interval_days;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      -- One client's failure (bad data, unexpected constraint hit) must not
      -- abort the whole business's run.
      v_errors := v_errors || jsonb_build_object(
        'client_external_id', v_client.external_id,
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'as_of', p_as_of,
    'window_end', v_window_end,
    'clients_processed', v_clients_processed,
    'jobs_created', v_jobs_created,
    'errors', v_errors
  );
END;
$$;

-- Not reachable via PostgREST or any authenticated/anon SQL role -- only
-- callable from inside the two SECURITY DEFINER wrappers below, which run
-- as this function's owner regardless of grants.
REVOKE ALL ON FUNCTION public.project_recurring_jobs_for_business(uuid, date, integer) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 4. Manager-facing wrapper -- resolves the CALLER's own business_id/role,
--    exactly mirroring set_job_actual_time's existing auth pattern (the
--    closest precedent for a SECURITY DEFINER function writing to jobs).
--    This is what the Admin "Project schedule now" button calls, under the
--    manager's own JWT -- can never target another tenant's business_id.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.project_recurring_jobs_now()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_user   public.users%ROWTYPE;
BEGIN
  SELECT u.* INTO v_user FROM public.users u WHERE u.id = auth.uid();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'No user row for current session';
  END IF;
  IF v_user.role NOT IN ('owner', 'admin', 'manager', 'dispatcher') THEN
    RAISE EXCEPTION 'Only owner/admin/manager/dispatcher can run schedule projection';
  END IF;

  RETURN public.project_recurring_jobs_for_business(v_user.business_id, current_date, 12);
END;
$$;

GRANT EXECUTE ON FUNCTION public.project_recurring_jobs_now() TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 5. Cron wrapper -- loops every tenant. Not exposed to authenticated/anon;
--    only reachable via cron.schedule below (runs as the scheduling role,
--    same pattern as trigger_poll_geotab_clocks -- no HTTP/Edge Function
--    hop needed here since there's no external API involved, just SQL).
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trigger_project_recurring_jobs_all_tenants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_business record;
  v_result   jsonb;
  v_results  jsonb := '[]'::jsonb;
BEGIN
  FOR v_business IN SELECT id FROM public.businesses WHERE deleted_at IS NULL LOOP
    BEGIN
      v_result := public.project_recurring_jobs_for_business(v_business.id, current_date, 12);
      v_results := v_results || v_result;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object('business_id', v_business.id, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('ran_at', now(), 'results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_project_recurring_jobs_all_tenants() FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 6. Data-quality report -- plain SECURITY INVOKER, relies entirely on the
--    existing clients_select RLS policy (auth_belongs_to_business) for
--    tenant scoping, same as any normal client-facing query. Report only --
--    never auto-fixes, per explicit instruction.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.flag_recurring_projection_issues()
RETURNS TABLE (
  client_id uuid,
  external_id text,
  first_name text,
  last_name text,
  frequency text,
  anchor_date date,
  issue text
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.id, c.external_id, c.first_name, c.last_name, c.frequency::text, c.anchor_date,
         'missing_anchor_date'
  FROM public.clients c
  WHERE c.status = 'active'
    AND c.frequency IS NOT NULL
    AND c.frequency <> 'OMS'
    AND c.anchor_date IS NULL

  UNION ALL
  SELECT c.id, c.external_id, c.first_name, c.last_name, c.frequency::text, c.anchor_date,
         'missing_frequency'
  FROM public.clients c
  WHERE c.status = 'active'
    AND c.frequency IS NULL

  UNION ALL
  -- Cadence drift: the client's most recent completed clean doesn't land
  -- on the anchor's day-of-week pattern (more than a few days off), meaning
  -- the real-world cadence has drifted away from anchor_date/frequency.
  -- Report only -- Tom decides whether to update the anchor, per instruction.
  SELECT d.id, d.external_id, d.first_name, d.last_name, d.frequency, d.anchor_date,
         'cadence_drifted'
  FROM (
    SELECT c.id, c.external_id, c.first_name, c.last_name, c.frequency::text, c.anchor_date,
           -- normalize (last_completed - anchor) mod interval into [0, interval),
           -- then remap into a signed (-interval/2, interval/2] "days off cycle"
           -- so e.g. 26 days off a 28-day cycle reads as -2 (early), not +26.
           (
             MOD(MOD((last_completed.date - c.anchor_date), iv.days) + iv.days, iv.days)
             - CASE WHEN MOD(MOD((last_completed.date - c.anchor_date), iv.days) + iv.days, iv.days) * 2 > iv.days
                    THEN iv.days ELSE 0 END
           ) AS days_off_cycle
    FROM public.clients c
    JOIN LATERAL (
      SELECT j.date FROM public.jobs j
      WHERE j.business_id = c.business_id AND j.client_id = c.external_id AND j.status = 'completed'
      ORDER BY j.date DESC LIMIT 1
    ) last_completed ON true
    CROSS JOIN LATERAL (SELECT public.recurring_interval_days(c.frequency::text) AS days) iv
    WHERE c.status = 'active'
      AND c.frequency IS NOT NULL
      AND c.frequency <> 'OMS'
      AND c.anchor_date IS NOT NULL
      AND iv.days IS NOT NULL
  ) d
  WHERE ABS(d.days_off_cycle) > 3
$$;

GRANT EXECUTE ON FUNCTION public.flag_recurring_projection_issues() TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 7. Nightly cron registration -- created INACTIVE. Per explicit
--    instruction this feature ships built and tested but not yet live:
--    activating the automatic nightly sweep across every tenant is a
--    separate, deliberate step. To activate:
--      UPDATE cron.job SET active = true WHERE jobname = 'project-recurring-jobs-nightly';
-- ═══════════════════════════════════════════════════════════════
SELECT cron.schedule(
  'project-recurring-jobs-nightly',
  '0 2 * * *',
  $$SELECT public.trigger_project_recurring_jobs_all_tenants();$$
);

-- Deactivate via cron.alter_job (direct UPDATE on cron.job is not
-- permitted for this role) -- signature is
-- alter_job(job_id, schedule, command, database, username, active).
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'project-recurring-jobs-nightly'),
  active := false
);
