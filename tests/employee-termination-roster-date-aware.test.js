// PR #149 — regression test for the getUnifiedRoster/getEmployeeTeam/
// getTeamEmployees date-aware termination fix.
//
// Before this fix, getUnifiedRoster blanket-excluded any employee with
// status='terminated' for EVERY date query, including dates before their
// termination -- 50 employees in production lost all historical
// hours/team-membership data because of this (confirmed live), not just
// future assignments. This directly covers the spec's downstream-effect
// requirement: "hours stop at termination_date, zero after" implies
// hours must still show correctly BEFORE termination_date, which the
// pre-#149 code could not do.
//
// Extracted and run from the ACTUAL source in index.html (not a
// reimplementation) -- getUnifiedRoster and getEmployeeTeam/
// getTeamEmployees live ~400 lines apart, so both ranges are extracted
// and concatenated into one sandbox.
//
// Run with: node tests/employee-termination-roster-date-aware.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label, fromIndex) {
  const startIdx = src.indexOf(startMarker, fromIndex || 0);
  if (startIdx === -1) {
    console.error('FAIL: could not find "' + startMarker + '" (' + label + ') in index.html — did it get refactored?');
    process.exit(1);
  }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    console.error('FAIL: could not find the end boundary for ' + label + ' — extraction range may need updating.');
    process.exit(1);
  }
  return { text: src.slice(startIdx, endIdx), endIdx: endIdx };
}

// getEmployeeTeam(employeeId, dateStr) matches TWO functions in this file --
// an earlier one inside the PentaAssignments IIFE, and the top-level one we
// actually want (which calls getUnifiedRoster). Search from after
// getUnifiedRoster's own location so indexOf can't grab the wrong one.
const rosterResult = extract('function getUnifiedRoster(asOfDate) {', '\n\n\n// Daily assignments', 'getUnifiedRoster');
const teamFnsResult = extract('function getEmployeeTeam(employeeId, dateStr) {', '\nasync function assignEmployee(employeeId, team, dateStr, extra) {', 'getEmployeeTeam/getTeamEmployees', rosterResult.endIdx);
const fnSource = rosterResult.text + '\n' + teamFnsResult.text;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(facadeRows, dailyAssignmentsOverride) {
  const sandbox = {
    console: console,
    EMPLOYEE_ROSTER: [],
    dailyAssignments: dailyAssignmentsOverride || {},
    window: { PentaEmployees: { listSync: function () { return facadeRows; } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

// A weekly employee, team B1, terminated 2026-08-20.
const TERMINATED_EMP = { id: 'emp-1', legacy_roster_id: null, name: 'Jane Doe', team: 'B1', team_text: 'B1', status: 'terminated', terminated_at: '2026-08-20', role: [] };
// A still-active teammate, for contrast.
const ACTIVE_EMP = { id: 'emp-2', legacy_roster_id: null, name: 'Bo Ng', team: 'B1', team_text: 'B1', status: 'active', terminated_at: null, role: [] };

// --- getUnifiedRoster(): no date (current-roster contexts) still blanket-excludes ---
{
  const sandbox = buildSandbox([TERMINATED_EMP, ACTIVE_EMP]);
  const roster = sandbox.getUnifiedRoster();
  check('bare getUnifiedRoster() (no date) still excludes a currently-terminated employee -- correct for "who\'s on the team right now" contexts, unchanged from pre-#149 behavior', roster.some(function(e){ return e.id === 'emp-1'; }), false);
  check('bare getUnifiedRoster() still includes the active teammate', roster.some(function(e){ return e.id === 'emp-2'; }), true);
}

// --- getUnifiedRoster(asOfDate): a date BEFORE termination includes them ---
{
  const sandbox = buildSandbox([TERMINATED_EMP, ACTIVE_EMP]);
  const roster = sandbox.getUnifiedRoster('2026-08-13'); // a week before termination
  check('getUnifiedRoster(dateBeforeTermination) includes the terminated employee -- this is the actual bug fix: historical hours must still show', roster.some(function(e){ return e.id === 'emp-1'; }), true);
}

// --- getUnifiedRoster(asOfDate): a date ON/AFTER termination excludes them ---
{
  const sandbox = buildSandbox([TERMINATED_EMP, ACTIVE_EMP]);
  const onDate = sandbox.getUnifiedRoster('2026-08-20');
  const afterDate = sandbox.getUnifiedRoster('2026-08-27');
  check('getUnifiedRoster(terminationDate itself) excludes them', onDate.some(function(e){ return e.id === 'emp-1'; }), false);
  check('getUnifiedRoster(dateAfterTermination) excludes them', afterDate.some(function(e){ return e.id === 'emp-1'; }), false);
}

// --- getEmployeeTeam: mirrors the same date-aware behavior end to end ---
{
  const sandbox = buildSandbox([TERMINATED_EMP, ACTIVE_EMP]);
  check('getEmployeeTeam resolves the historical team for a date before termination', sandbox.getEmployeeTeam('emp-1', '2026-08-13'), 'B1');
  check('getEmployeeTeam resolves null for a date after termination (falls through to no defaultTeam match)', sandbox.getEmployeeTeam('emp-1', '2026-08-27'), null);
}

// --- getTeamEmployees: the actual Hours-table/roster consumer ---
{
  const sandbox = buildSandbox([TERMINATED_EMP, ACTIVE_EMP]);
  const beforeTermination = sandbox.getTeamEmployees('B1', '2026-08-13').map(function(e){ return e.id; }).sort();
  const afterTermination = sandbox.getTeamEmployees('B1', '2026-08-27').map(function(e){ return e.id; }).sort();
  check('getTeamEmployees for a date before termination includes both employees (historical hours correct)', beforeTermination, ['emp-1', 'emp-2']);
  check('getTeamEmployees for a date after termination includes only the still-active employee', afterTermination, ['emp-2']);
}

// --- An explicit dailyAssignments override (a specific day-off/reassignment) always wins, regardless of termination status ---
{
  const sandbox = buildSandbox([TERMINATED_EMP, ACTIVE_EMP], { '2026-08-13_emp-1': 'S1' });
  check('an explicit per-date override still takes priority over the default-team lookup', sandbox.getEmployeeTeam('emp-1', '2026-08-13'), 'S1');
}

// --- An employee terminated via the OLD status-dropdown path (no terminated_at) is not retroactively hidden -- fails open, not silently broken ---
{
  const legacyTerminated = { id: 'emp-5', legacy_roster_id: null, name: 'Legacy Term', team: 'M1', team_text: 'M1', status: 'terminated', terminated_at: null, role: [] };
  const sandbox = buildSandbox([legacyTerminated]);
  check('a status=terminated employee with no terminated_at (pre-#149 data gap) is NOT excluded by date -- known, documented edge case, fails toward "still shown" not "hidden"', sandbox.getUnifiedRoster('2026-08-27').some(function(e){ return e.id === 'emp-5'; }), true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
