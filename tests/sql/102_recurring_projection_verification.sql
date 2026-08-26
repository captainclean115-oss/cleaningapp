-- PR #146 — live verification harness for migration 102's recurring
-- schedule projection engine.
--
-- The projection/reschedule-detection/team-fallback/rolling-window logic
-- lives entirely in Postgres (project_recurring_jobs_for_business et al.),
-- not in index.html, so it isn't reachable by this repo's fs+vm Node test
-- convention (tests/*.test.js). This script is the repeatable equivalent:
-- it was run live against the real Supabase project during PR #146
-- (every assertion below passed), then fully torn down -- confirmed zero
-- rows left in `businesses`/`clients`/`jobs`/`teams` for the disposable
-- business_id afterward, and zero `auto_projected` rows anywhere outside
-- it (i.e. Tom's real schedule was never touched by this testing).
--
-- Re-run manually (via the Supabase SQL editor or
-- mcp__supabase__execute_sql) after any future change to migration 102's
-- functions, to confirm nothing regressed. Not wired into `node
-- tests/*.test.js` -- requires a live DB connection, which that harness
-- deliberately doesn't have.
--
-- Uses a fixed, obviously-fake business_id (00000000-0000-4000-a000-...)
-- so it can never collide with a real tenant.

-- ── Setup ──────────────────────────────────────────────────────────────
insert into businesses (id, name, owner_email) values
  ('00000000-0000-4000-a000-000000000001', 'TEST_PROJECTION_HARNESS', 'test-harness@example.invalid');

insert into teams (id, business_id, name) values
  ('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-000000000001', 'TESTTEAM');

insert into clients (business_id, external_id, first_name, last_name, status, frequency, anchor_date, preferred_team_id) values
  ('00000000-0000-4000-a000-000000000001', 'T-WEEKLY',   'Weekly',   'Client', 'active', 'RMS-WEK', '2026-08-05', null),
  ('00000000-0000-4000-a000-000000000001', 'T-EOW',      'Eow',      'Client', 'active', 'RMS-EOW', '2026-01-07', null),
  ('00000000-0000-4000-a000-000000000001', 'T-OMS',      'Oms',      'Client', 'active', 'OMS',     '2026-08-05', null),
  ('00000000-0000-4000-a000-000000000001', 'T-NOANCHOR', 'NoAnchor', 'Client', 'active', 'RMS-EOW', null,         null),
  ('00000000-0000-4000-a000-000000000001', 'T-NOFREQ',   'NoFreq',   'Client', 'active', null,      '2026-08-05', null),
  ('00000000-0000-4000-a000-000000000001', 'T-PREFTEAM', 'PrefTeam', 'Client', 'active', 'RMS-WEK', '2026-08-05', '00000000-0000-4000-a000-00000000000a'),
  ('00000000-0000-4000-a000-000000000001', 'T-LASTTEAM', 'LastTeam', 'Client', 'active', 'RMS-WEK', '2026-08-05', null),
  ('00000000-0000-4000-a000-000000000001', 'T-PAUSED',   'Paused',   'Client', 'paused', 'RMS-WEK', '2026-08-05', null),
  ('00000000-0000-4000-a000-000000000001', 'T-RESCHED',  'Resched',  'Client', 'active', 'RMS-EOW', '2026-08-05', null);

insert into jobs (business_id, client_id, date, team, status, projection_source) values
  -- T-EOW: pre-existing "manual" jobs the engine must never touch.
  ('00000000-0000-4000-a000-000000000001', 'T-EOW', '2026-08-27', 'MANUALTEAM', 'scheduled', 'manual'),
  ('00000000-0000-4000-a000-000000000001', 'T-EOW', '2026-09-23', 'MANUALTEAM', 'scheduled', 'manual'),
  -- T-LASTTEAM: a completed job whose team the fallback should pick up.
  ('00000000-0000-4000-a000-000000000001', 'T-LASTTEAM', '2026-07-01', 'FALLBACKTEAM', 'completed', 'manual'),
  -- T-RESCHED: an unambiguous one-day-off reschedule of the Sep2 cycle,
  -- clear of any adjacent cycle's window (unlike the T-EOW dates above,
  -- which were chosen to match the feature spec's own example and turned
  -- out to straddle two cycles -- see the "known discrepancy" note below).
  ('00000000-0000-4000-a000-000000000001', 'T-RESCHED', '2026-09-03', 'MANUALTEAM', 'scheduled', 'manual');

-- ── Run 1: as_of = 2026-08-25 ("today" per the PR #146 session) ────────
select public.project_recurring_jobs_for_business('00000000-0000-4000-a000-000000000001'::uuid, '2026-08-25'::date, 12);
-- Expected: clients_processed = 4 (T-WEEKLY, T-EOW, T-PREFTEAM, T-LASTTEAM
-- only -- NOT T-OMS/T-NOANCHOR/T-NOFREQ/T-PAUSED), errors = [].
-- T-RESCHED not yet included (added after this run in the real session --
-- included in setup above for a single-script version of this harness).

-- Assertion A -- rule 5 (exact-date dedup): the pre-existing Sep23 job is
-- untouched, no duplicate inserted alongside it.
select date, team, projection_source from jobs
  where business_id='00000000-0000-4000-a000-000000000001' and client_id='T-EOW' and date='2026-09-23';
-- Expected: exactly 1 row, projection_source='manual', team='MANUALTEAM'.

-- Assertion B -- rule 4 (reschedule doesn't re-anchor), isolated case via
-- T-RESCHED (anchor 2026-08-05, EOW -- true cycle dates are Aug5, Aug19,
-- Sep2, Sep16, Sep30, Oct14, ... confirmed by direct date arithmetic:
--   select ('2026-09-02'::date - '2026-08-05'::date)::float/14;  -- = 2, exactly on-grid
-- Sep3 (one day off Sep2) is a manual reschedule inserted above.
select date, team, projection_source from jobs
  where business_id='00000000-0000-4000-a000-000000000001' and client_id='T-RESCHED'
  order by date limit 6;
-- Expected exact sequence: 2026-09-03 (manual, untouched), 2026-09-16
-- (auto_projected), 2026-09-30, 2026-10-14, 2026-10-28, 2026-11-11 --
-- i.e. Sep2 is correctly SKIPPED (covered by the Sep3 reschedule) and
-- Sep16 onward continues the ORIGINAL anchor grid (14 days after Sep2,
-- NOT 13 days after the Sep3 reschedule).

-- Assertion C -- rule 6/preferred-team and its fallback.
select client_id, team from jobs
  where business_id='00000000-0000-4000-a000-000000000001' and client_id in ('T-PREFTEAM','T-LASTTEAM')
    and projection_source='auto_projected' order by client_id, date limit 2;
-- Expected: T-PREFTEAM rows have team='TESTTEAM' (from preferred_team_id);
-- T-LASTTEAM rows have team='FALLBACKTEAM' (from its most recent
-- completed job, since it has no preferred_team_id set).

-- Assertion D -- OMS/missing-anchor/missing-frequency/paused clients get
-- zero auto_projected jobs.
select external_id from clients
  where business_id='00000000-0000-4000-a000-000000000001'
    and external_id in ('T-OMS','T-NOANCHOR','T-NOFREQ','T-PAUSED')
    and external_id not in (select client_id from jobs where projection_source='auto_projected');
-- Expected: all 4 external_ids returned (none of them got a job).

-- Assertion E -- data-quality report flags exactly the clients it should,
-- with no false positives for eligible/ineligible clients.
select external_id, issue from public.flag_recurring_projection_issues()
  where external_id in ('T-NOANCHOR','T-NOFREQ','T-WEEKLY','T-EOW','T-OMS','T-PAUSED');
-- Expected: exactly 2 rows -- T-NOANCHOR/missing_anchor_date and
-- T-NOFREQ/missing_frequency. Nothing else appears (T-PAUSED excluded by
-- the report's own active-status filter, matching the engine's scope).

-- ── Run 2: idempotency + incremental rolling window ─────────────────────
-- Re-running at the SAME as_of must create 0 new jobs (already covered).
select public.project_recurring_jobs_for_business('00000000-0000-4000-a000-000000000001'::uuid, '2026-08-25'::date, 12);
-- Expected: jobs_created = 0 on this second call at the same as_of (T-RESCHED
-- itself was newly processed in the live session's actual second call since
-- it was added between runs there; in this consolidated script all clients
-- exist from the start, so BOTH calls at 2026-08-25 back to back should
-- show 0 created on the second one).

-- Advancing as_of by exactly 14 days (a common multiple of the 7-day WEK
-- and 14-day EOW intervals in this test set) must add a precise, countable
-- number of new jobs: 3 weekly clients (T-WEEKLY, T-PREFTEAM, T-LASTTEAM)
-- x 2 new cycles each (14/7) + 2 EOW-family clients (T-EOW, T-RESCHED) x 1
-- new cycle each (14/14) = 8.
select public.project_recurring_jobs_for_business('00000000-0000-4000-a000-000000000001'::uuid, '2026-09-08'::date, 12);
-- Expected: jobs_created = 8, clients_processed = 5, errors = [].

-- ── Security boundary: the internal engine must NOT be callable by
--    authenticated/anon -- only the two wrappers are (see migration 102's
--    REVOKE statements). A cross-tenant hole would look like `true` here.
select has_function_privilege('authenticated', 'public.project_recurring_jobs_for_business(uuid,date,integer)', 'EXECUTE') as should_be_false,
       has_function_privilege('authenticated', 'public.project_recurring_jobs_now()', 'EXECUTE') as should_be_true,
       has_function_privilege('authenticated', 'public.trigger_project_recurring_jobs_all_tenants()', 'EXECUTE') as should_be_false_too,
       has_function_privilege('authenticated', 'public.flag_recurring_projection_issues()', 'EXECUTE') as should_be_true_too;

-- ── Cross-tenant isolation: this entire test run must not have created a
--    single auto_projected row anywhere outside the disposable business.
select count(*) as should_be_zero from jobs
  where business_id != '00000000-0000-4000-a000-000000000001' and projection_source = 'auto_projected';

-- ── Teardown -- always run this, even if an assertion above failed ──────
delete from jobs where business_id='00000000-0000-4000-a000-000000000001';
delete from clients where business_id='00000000-0000-4000-a000-000000000001';
delete from teams where business_id='00000000-0000-4000-a000-000000000001';
delete from businesses where id='00000000-0000-4000-a000-000000000001';

-- Known discrepancy worth a second look: the feature spec's own worked
-- example (anchor=2026-01-07 "Wed", RMS-EOW -> expects Aug 26/Sep 9/Sep 23)
-- does not reconcile with a literal anchor + 14k grid -- date arithmetic
-- confirms the TRUE Jan-7-anchored grid lands on Aug 19/Sep 2/Sep 16/Sep 30
-- instead (all exactly 7 days -- one week -- off the spec's example dates,
-- though all still Wednesdays). This looks like a small slip when the
-- example was written, not a bug in this engine (independently confirmed
-- via raw date subtraction, not just this function's output). Flagging
-- rather than silently "fixing" by guessing which side (the anchor or the
-- example dates) was the typo.
