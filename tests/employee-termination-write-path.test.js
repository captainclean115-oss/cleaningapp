// PR #149 — regression test for PentaEmployees' _toRow/_fromRow mapping
// of the 4 new termination columns (migration 104). Guards the exact bug
// class PR #138/#148 found elsewhere in this codebase: a field present in
// a write patch but missing from the facade's transform function, which
// silently drops it from the outgoing Supabase payload with no error.
//
// Extracted and run from the ACTUAL _toRow/_fromRow source in index.html
// (not a reimplementation).
//
// Run with: node tests/employee-termination-write-path.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'function _slug(first, last) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find _slug in index.html — did PentaEmployees get refactored?');
  process.exit(1);
}
const endIdx = src.indexOf('\n\n  async function _businessId() {', startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after _fromRow — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const sandbox = { console: console };
vm.createContext(sandbox);
vm.runInContext(fnSource, sandbox);

// --- Write direction (_toRow): a full termination patch ---
{
  const row = sandbox._toRow({
    status: 'terminated', terminated_at: '2026-08-27',
    termination_reason: 'layoff', termination_notes: 'Route consolidated', terminated_by: 'manager-1', eligible_for_rehire: true,
  }, { mode: 'update' });
  check('status reaches the payload', row.status, 'terminated');
  check('terminated_at reaches the payload', row.terminated_at, '2026-08-27');
  check('termination_reason reaches the payload', row.termination_reason, 'layoff');
  check('termination_notes reaches the payload', row.termination_notes, 'Route consolidated');
  check('terminated_by reaches the payload', row.terminated_by, 'manager-1');
  check('eligible_for_rehire reaches the payload', row.eligible_for_rehire, true);
}

// --- Write direction: rehire's explicit-null clear must actually clear, not be dropped ---
// This is the exact failure mode to guard against: `!= null` on these
// fields would silently skip an explicit `null` in the patch, leaving the
// stale termination data in the database after a "successful" rehire.
{
  const row = sandbox._toRow({
    status: 'active', terminated_at: null, termination_reason: null, termination_notes: null, terminated_by: null,
  }, { mode: 'update' });
  check('terminated_at explicit null actually clears (not silently dropped)', row.terminated_at, null);
  check('termination_reason explicit null actually clears', row.termination_reason, null);
  check('termination_notes explicit null actually clears', row.termination_notes, null);
  check('terminated_by explicit null actually clears', row.terminated_by, null);
}

// --- A patch that never mentions these fields must not invent them ---
{
  const row = sandbox._toRow({ first_name: 'Jane' }, { mode: 'update' });
  check('termination_reason key is absent entirely when not in the patch (no phantom writes)', Object.prototype.hasOwnProperty.call(row, 'termination_reason'), false);
  check('eligible_for_rehire key is absent entirely when not in the patch', Object.prototype.hasOwnProperty.call(row, 'eligible_for_rehire'), false);
}

// --- Read direction (_fromRow): a terminated employee row round-trips correctly ---
{
  const emp = sandbox._fromRow({
    id: 'emp-1', business_id: 'biz-1', first_name: 'Jane', last_name: 'Doe',
    status: 'terminated', terminated_at: '2026-08-27',
    termination_reason: 'layoff', termination_notes: 'Route consolidated', terminated_by: 'manager-1', eligible_for_rehire: false,
  });
  check('reads status', emp.status, 'terminated');
  check('reads terminated_at', emp.terminated_at, '2026-08-27');
  check('reads termination_reason', emp.termination_reason, 'layoff');
  check('reads termination_notes', emp.termination_notes, 'Route consolidated');
  check('reads terminated_by', emp.terminated_by, 'manager-1');
  check('reads eligible_for_rehire as a real boolean (false), not just falsy/undefined', emp.eligible_for_rehire, false);
}

// --- Read direction: an active employee (no termination data) reads cleanly, no phantom values ---
{
  const emp = sandbox._fromRow({ id: 'emp-2', business_id: 'biz-1', first_name: 'Bo', last_name: 'Ng', status: 'active' });
  check('termination_reason reads as null, not undefined (used directly in template strings elsewhere)', emp.termination_reason, null);
  check('termination_notes reads as null', emp.termination_notes, null);
  check('terminated_by reads as null', emp.terminated_by, null);
  check('eligible_for_rehire reads as null when the column itself is null (distinguishable from an explicit false, per spec)', emp.eligible_for_rehire, null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
