-- Backfill jobs.actual_minutes from the Maids CSV staging table for jobs
-- completed before GPS-based tracking went live. "Actual InHome Min" in
-- the Maids export is already total time x team size -- stored as-is,
-- no recomputation.
--
-- Match key: business_id + customer_id (= jobs.client_id, confirmed a
-- direct text match, no clients.external_id hop needed) + service date +
-- start time, normalized to HH24:MI so it compares against jobs.time.
-- jobstatus filter mirrors maidsMapStatus() in index.html exactly
-- (complete/completed/closed -> Penta 'completed') so this backfill's
-- notion of "done" matches the importer's.
--
-- Ambiguity guard: only writes when every matching staging row (there
-- can be harmless exact duplicates across source files) agrees on a
-- single actual-minutes value. Jobs whose matches disagree, or that have
-- no matching staging row at all, are left untouched -- see the PR
-- description for the exact counts of each bucket (9850 backfilled of
-- 9878 completed jobs; 1 skipped as ambiguous; 27 with no matching CSV
-- row, all against live Manna Maids data at time of writing).
with staged as (
  select
    s.business_id,
    s.customer_id,
    to_date(s.raw->>'date', 'MM/DD/YYYY')                                    as svc_date,
    to_char(to_timestamp(s.raw->>'starttime', 'HH12:MI AM'), 'HH24:MI')      as start_hhmm,
    nullif(s.raw->>'actualinhomemin', '')::int                               as actual_min
  from public.maids_import_staging s
  where lower(trim(s.raw->>'jobstatus')) in ('complete', 'completed', 'closed')
),
matched as (
  select j.id as job_id, array_agg(distinct st.actual_min) as vals
  from public.jobs j
  join staged st
    on st.business_id  = j.business_id
   and st.customer_id  = j.client_id
   and st.svc_date     = j.date
   and st.start_hhmm   = j.time
  where j.status = 'completed'
  group by j.id
)
update public.jobs
set actual_minutes = m.vals[1]
from matched m
where jobs.id = m.job_id
  and array_length(m.vals, 1) = 1;
