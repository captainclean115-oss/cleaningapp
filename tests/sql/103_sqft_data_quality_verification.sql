-- PR #148 — live verification for migration 103's sqft data-quality flag.
--
-- Run live during PR #148 (every assertion below passed), then torn down.
-- The flagging logic lives in Postgres (flag_sqft_discrepancies), so it
-- isn't reachable by this repo's fs+vm Node test convention -- this is the
-- repeatable version, matching the PR #146/#147 convention for live-DB
-- logic verification. Uses disposable clients (external_id 999999901-904,
-- clearly fake) so it can never collide with a real client.

insert into clients (business_id, external_id, first_name, last_name, sqft, sqft_from_records, sqft_source) values
  ((select business_id from clients limit 1), '999999901', 'Sqft', 'Flagged25pct',       2000, 2500, 'manual'),
  ((select business_id from clients limit 1), '999999902', 'Sqft', 'NotFlagged5pct',     2000, 2100, 'manual'),
  ((select business_id from clients limit 1), '999999903', 'Sqft', 'ManualOnlyNoRecords', 2000, null, 'manual'),
  ((select business_id from clients limit 1), '999999904', 'Sqft', 'AutoOnlyNoManual',    2200, null, 'auto');

select external_id, sqft, sqft_from_records, diff_pct from public.flag_sqft_discrepancies()
  where external_id in ('999999901','999999902','999999903','999999904');
-- Expected: EXACTLY ONE row -- external_id='999999901', diff_pct=25.
-- The other three (5% diff, no records, no manual entry) must not appear
-- at all -- matching the spec's test plan exactly:
--   - manual 2000 / records 2500 (25% diff) -> flagged
--   - manual 2000 / records 2100 (5% diff)  -> NOT flagged
--   - manual only, no records               -> NOT flagged (no basis)
--   - auto-enriched only, no manual         -> NOT flagged

delete from clients where external_id in ('999999901','999999902','999999903','999999904')
  returning external_id;
-- Expected: 4 rows, confirming full cleanup -- this script must never
-- leave residue in a real business_id.
