// PR #148 -- regression test for terminated employees (with no terminated_at
// set) leaking into "current roster" views: Team Manager, Move Employee,
// Day Off picker, route rosters -- every one of these calls the bare,
// no-argument getUnifiedRoster().
//
// Root cause: getUnifiedRoster()'s termination check was
//   fe.status === 'terminated' && fe.terminated_at && (!asOfDate || asOfDate >= fe.terminated_at)
// The `fe.terminated_at &&` short-circuit meant ANY terminated employee
// missing terminated_at (never excluded, regardless of asOfDate) passed
// straight through as if still active. Confirmed live: 10+ real Manna
// employees are status='terminated', deleted_at IS NULL (so not caught by
// PentaEmployees._hydrate's deleted_at filter either), and terminated_at
// IS NULL -- including several obviously-test rows ("test123", "tg",
// "Jane j", "testing2027") and an old duplicate "Melissa Manna" record.
// These are DISTINCT from the pre-#144 40-employee deleted_at gap
// (see project_employee_termination_rehire.md) -- that group is invisible
// EVERYWHERE (hydrate filters deleted_at); this group is only missing
// terminated_at, so it's fully visible in the facade and was leaking
// specifically into "who's currently on the team" views.
//
// The fix only changes the UNDATED-call behavior. A DATED call
// (asOfDate provided, e.g. resolving historical hours) keeps the existing,
// deliberate "fail toward shown when terminated_at is unknown" behavior --
// already covered by employee-termination-roster-date-aware.test.js and
// unchanged here.
//
// Run with: node tests/unified-roster-terminated-no-date-leak.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const fnSource = extract('function getUnifiedRoster(asOfDate) {', '\n\n\n// Daily assignments', 'getUnifiedRoster');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(facadeRows) {
  const sandbox = {
    console,
    EMPLOYEE_ROSTER: [],
    window: { PentaEmployees: { listSync: () => facadeRows } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

// Mirrors the real, live data shape: status='terminated', deleted_at null,
// terminated_at null -- the exact gap that leaked into Team Manager.
const NO_DATE_TERMINATED = { id: 'test123', legacy_roster_id: null, name: 'test123', team: 'B1', team_text: 'B1', status: 'terminated', deleted_at: null, terminated_at: null, role: [] };
const ACTIVE_EMP = { id: 'emp-real', legacy_roster_id: null, name: 'Real Employee', team: 'B1', team_text: 'B1', status: 'active', deleted_at: null, terminated_at: null, role: [] };

{
  const sandbox = buildSandbox([NO_DATE_TERMINATED, ACTIVE_EMP]);
  const roster = sandbox.getUnifiedRoster();
  check('bare getUnifiedRoster() excludes a terminated employee with NO terminated_at set (the actual leak -- Team Manager, Move Employee, Day Off, route rosters all call this bare)', roster.some(function (e) { return e.id === 'test123'; }), false);
  check('bare getUnifiedRoster() still includes the real active employee', roster.some(function (e) { return e.id === 'emp-real'; }), true);
}

// A DATED call must still fail toward "shown" when terminated_at is
// missing -- this is the pre-existing, deliberate behavior for historical
// hours and must not regress.
{
  const sandbox = buildSandbox([NO_DATE_TERMINATED]);
  const roster = sandbox.getUnifiedRoster('2026-08-13');
  check('a DATED call still includes a terminated employee with no terminated_at (unchanged -- protects historical hours per the documented pre-#149 data-gap case)', roster.some(function (e) { return e.id === 'test123'; }), true);
}

// A terminated employee WITH terminated_at set is still correctly excluded
// from a bare call (this already worked -- must not regress).
{
  const withDate = Object.assign({}, NO_DATE_TERMINATED, { id: 'emp-dated', terminated_at: '2026-08-20' });
  const sandbox = buildSandbox([withDate]);
  const roster = sandbox.getUnifiedRoster();
  check('bare getUnifiedRoster() still excludes a terminated employee that DOES have terminated_at set (pre-existing behavior, unchanged)', roster.some(function (e) { return e.id === 'emp-dated'; }), false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
