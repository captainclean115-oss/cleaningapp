-- Activates real per-job clock times (actual_start_at/actual_end_at) for
-- Manna Maids going forward. Diagnosed: jobs.actual_start_at/actual_end_at
-- were null on all 14,069 of the business's jobs, ever -- not a bug in any
-- write path, but two per-tenant safety switches that were simply never
-- flipped on:
--   - business_geotab_integrations.gps_clock_writes_enabled (default
--     false, migration 076) gates write_job_gps_clock, the function the
--     already-running poll-geotab-clocks cron (verified live: succeeding
--     every 15 min) calls to record GPS-geofence-matched clock times.
--     Confirmed safe: never overwrites an existing actual_start_at/
--     actual_end_at (WHERE ... IS NULL guard), whether set manually or by
--     a prior GPS write.
--   - businesses.gps_verification_start_date (default null, migration
--     100) gates compute_job_actual_minutes, the trigger that recomputes
--     actual_minutes FROM actual_start_at/actual_end_at once both are
--     set. With it null, the trigger no-ops for every job regardless of
--     date -- which is also why actual_minutes on all pre-existing jobs
--     came from the one-time 2026-08-05 CSV import instead, not from any
--     live computation.
--
-- Tom's call: fix going forward only, explicitly skip backfilling the
-- 14,069 existing null jobs (payroll doesn't read this field). Both
-- migration 100's trigger (date < cutover -> no-op) and this cutover
-- date being set to today already implement "going forward" without any
-- new logic -- past jobs are structurally untouched by either switch.

update public.business_geotab_integrations
set gps_clock_writes_enabled = true
where business_id = '48532f06-0625-415b-9091-2638bed6506d';

update public.businesses
set gps_verification_start_date = current_date
where id = '48532f06-0625-415b-9091-2638bed6506d';
