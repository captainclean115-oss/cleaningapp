-- Reverts migration 106 (PR #152) for Manna only. Tom's call, no
-- diagnosis behind it recorded here -- just undo the two per-tenant
-- switches back to their pre-#152 defaults. Does not touch
-- poll-geotab-clocks-every-15-min (cron.job id=2) -- that cron is
-- global, serving every tenant with an active Geotab integration, not
-- Manna-specific, and was explicitly left running.

update public.business_geotab_integrations
set gps_clock_writes_enabled = false
where business_id = '48532f06-0625-415b-9091-2638bed6506d';

update public.businesses
set gps_verification_start_date = null
where id = '48532f06-0625-415b-9091-2638bed6506d';
