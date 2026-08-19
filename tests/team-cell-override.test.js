// PR #130 — regression test for the class of bug this file documents at
// length in project memory as "mirrored algorithm copies diverge": a
// per-day team lookup silently reading a cached/default value instead of
// resolving fresh per date.
//
// This does NOT re-implement getEmployeeTeam's logic and test the copy —
// that's exactly how a real divergence would go undetected. It extracts
// the actual function source out of index.html and runs it, so a change
// to the real function is what this test exercises.
//
// Run with: node tests/team-cell-override.test.js
// No dependencies beyond Node's built-ins (fs, vm).

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

// Extract the top-level getEmployeeTeam(employeeId, dateStr) function —
// NOT the differently-behaved PentaAssignments.getEmployeeTeam method
// (indented, scoped inside that IIFE) — by matching the unindented
// `function getEmployeeTeam` through to the next top-level function.
const startMarker = '\nfunction getEmployeeTeam(employeeId, dateStr) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find top-level getEmployeeTeam in index.html — did it get renamed or moved?');
  process.exit(1);
}
const nextFnIdx = src.indexOf('\nfunction getTeamEmployees(', startIdx);
if (nextFnIdx === -1) {
  console.error('FAIL: could not find the getTeamEmployees boundary after getEmployeeTeam — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx + 1, nextFnIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function callGetEmployeeTeam(dailyAssignmentsState, employeeId, dateStr, defaultTeam) {
  const sandbox = {
    dailyAssignments: dailyAssignmentsState,
    getUnifiedRoster: function () { return [{ id: employeeId, defaultTeam: defaultTeam }]; },
    console: console,
  };
  vm.createContext(sandbox);
  const script = new vm.Script(fnSource + '\ngetEmployeeTeam(' + JSON.stringify(employeeId) + ', ' + JSON.stringify(dateStr) + ');');
  return script.runInContext(sandbox);
}

console.log('Testing extracted getEmployeeTeam() from index.html\n');

// Case 1: no override for the date -> falls through to defaultTeam.
check(
  'no override -> returns employee defaultTeam',
  callGetEmployeeTeam({}, 'elvia-id', '2026-08-18', 'B1'),
  'B1'
);

// Case 2: THE Elvia scenario -- an active override to a different team
// than defaultTeam must win, not the default.
check(
  'override present (B5) on a day whose defaultTeam is B1 -> returns the override, not the default',
  callGetEmployeeTeam({ '2026-08-18_elvia-id': 'B5' }, 'elvia-id', '2026-08-18', 'B1'),
  'B5'
);

// Case 3: an OFF override must resolve to null, not the string 'OFF' and
// not the default team.
check(
  'OFF override -> returns null (not "OFF", not defaultTeam)',
  callGetEmployeeTeam({ '2026-08-18_elvia-id': 'OFF' }, 'elvia-id', '2026-08-18', 'B1'),
  null
);

// Case 4: an override on a DIFFERENT date must not leak into today's
// resolution -- confirms the key is date-scoped, not just employee-scoped.
check(
  'override on a different date does not affect the queried date',
  callGetEmployeeTeam({ '2026-08-17_elvia-id': 'B5' }, 'elvia-id', '2026-08-18', 'B1'),
  'B1'
);

// Case 5: an override for a DIFFERENT employee must not leak either.
check(
  'override for a different employee does not affect the queried employee',
  callGetEmployeeTeam({ '2026-08-18_someone-else': 'B5' }, 'elvia-id', '2026-08-18', 'B1'),
  'B1'
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
