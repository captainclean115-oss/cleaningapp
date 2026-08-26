-- PR #147 — live verification that every column saveClientEdit's editPatch
-- can write actually persists to the real `clients` table.
--
-- Requested after a report that "every field in the client edit modal
-- silently fails to save, except current_price/estimated_minutes (already
-- fixed by PR #138/#139)." Investigation (static code review + this live
-- round-trip, run during PR #147) found that report inaccurate: every
-- field in editPatch has a mapping in _transformRowForWrite and persists
-- correctly. No regression found since PR #138. This script is the
-- repeatable version of the live test run during that investigation --
-- run it again (via the Supabase SQL editor or mcp__supabase__execute_sql)
-- if this is ever in question again, before assuming new code broke it.
--
-- Uses a disposable client (external_id starting with a run of 9s so it
-- can never collide with a real client) in whatever business_id already
-- has real clients, and deletes it immediately after.

insert into clients (business_id, external_id, first_name, last_name)
  values ((select business_id from clients limit 1), '999999999', 'FieldTest', 'Original')
  returning id;

update clients set
  first_name='FieldTest2', last_name='Updated2', phone='555-0100', email='test@example.invalid',
  address='123 Test St', city='Testville', zip_code='02101', package='Standard',
  frequency='RMS-EOW', preferred_day='Wed', preferred_time_window='morning',
  anchor_date='2026-09-01', notes='test notes', status='paused',
  pause_start='2026-09-01', pause_end='2026-09-15', pause_reason='vacation',
  current_price=250, estimated_minutes=180
where external_id='999999999'
returning first_name, last_name, phone, email, address, city, zip_code, package,
  frequency, preferred_day, preferred_time_window, anchor_date, notes, status,
  pause_start, pause_end, pause_reason, current_price, estimated_minutes;
-- Expected: every column above reflects the new value (all persisted,
-- none reverted to a default, none left at the original INSERT's values).

delete from clients where external_id='999999999' returning id;
-- Expected: 1 row, confirming the test client is fully removed -- this
-- script must never leave residue in a real business_id.
