-- Ongoing (post-cutover) auto-computation of jobs.actual_minutes from GPS
-- clock times, going forward from each business's own
-- businesses.gps_verification_start_date. That column was added as pure
-- scaffolding earlier (comment on the admin UI: "no cross-check logic
-- reads it yet -- that's separate, deferred future work") -- this is
-- that deferred work, reused rather than inventing a second cutover
-- concept. Per-tenant NULL (the default) means the trigger computes
-- nothing for that business, same "not set -> disabled" semantics the
-- admin UI already states.
--
-- Manual-vs-GPS precedence for actual_start_at/actual_end_at is already
-- resolved upstream, before this trigger ever sees the row:
--   - set_job_actual_time() (manual team-leader start/end tap) always
--     overwrites unconditionally.
--   - write_job_gps_clock() (GPS geofence match) only writes
--     WHERE actual_start_at/actual_end_at IS NULL -- it defers to
--     whatever's already there, manual or a prior GPS write.
-- So by the time actual_end_at is non-null on a row this trigger reads,
-- it is already the correct, final clock time regardless of source --
-- this trigger doesn't need its own GPS-vs-manual branch.
--
-- Formula: (actual_end_at - actual_start_at in minutes) x team_size,
-- where team_size = COUNT(DISTINCT employee_id) from daily_assignments
-- for that job's team + date (deleted_at IS NULL = active assignment).
--
-- actual_minutes_flag records WHY a job was left unflagged/null instead
-- of silently guessing -- same "store the reason, don't guess" pattern
-- as jobs.team_code_raw for unmapped Maids teams.

alter table public.jobs
  add column if not exists actual_minutes_flag text;

comment on column public.jobs.actual_minutes_flag is
  'Set by compute_job_actual_minutes() when actual_minutes could not be computed and Tom needs to look at the job: no_team_assignments (team null or 0 employees in daily_assignments that day), missing_start_time, end_before_start. NULL when actual_minutes was computed normally or the job predates the tenant''s gps_verification_start_date cutover.';

create or replace function public.compute_job_actual_minutes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cutover   date;
  v_team_size integer;
begin
  select b.gps_verification_start_date into v_cutover
  from public.businesses b
  where b.id = new.business_id;

  -- Cutover not set for this tenant, or this job predates it: leave
  -- actual_minutes alone. That range belongs to the CSV backfill / manual
  -- entry, not this trigger -- don't clobber it just because someone
  -- edited an unrelated field on an old completed job.
  if v_cutover is null or new.date < v_cutover then
    return new;
  end if;

  if new.actual_start_at is null then
    new.actual_minutes := null;
    new.actual_minutes_flag := 'missing_start_time';
    return new;
  end if;

  if new.actual_end_at <= new.actual_start_at then
    new.actual_minutes := null;
    new.actual_minutes_flag := 'end_before_start';
    raise warning '[compute_job_actual_minutes] job % has actual_end_at <= actual_start_at (start=%, end=%)',
      new.id, new.actual_start_at, new.actual_end_at;
    return new;
  end if;

  select count(distinct employee_id) into v_team_size
  from public.daily_assignments
  where business_id = new.business_id
    and date = new.date
    and team = new.team
    and deleted_at is null;

  if new.team is null or v_team_size = 0 then
    new.actual_minutes := null;
    new.actual_minutes_flag := 'no_team_assignments';
    raise warning '[compute_job_actual_minutes] job % has no active daily_assignments for team % on % -- actual_minutes not computed, flagged for review',
      new.id, new.team, new.date;
    return new;
  end if;

  new.actual_minutes := round(
    (extract(epoch from (new.actual_end_at - new.actual_start_at)) / 60.0) * v_team_size
  )::integer;
  new.actual_minutes_flag := null;
  return new;
end;
$$;

drop trigger if exists trg_compute_job_actual_minutes on public.jobs;
create trigger trg_compute_job_actual_minutes
  before insert or update of actual_start_at, actual_end_at, team, date on public.jobs
  for each row
  when (new.actual_end_at is not null)
  execute function public.compute_job_actual_minutes();
