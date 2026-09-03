// Bug: Tom moved Melissa Manna to B1 for tomorrow (2026-09-04) via the
// admin Teams & Schedule UI. The write succeeded (confirmed live:
// daily_assignments row, date=2026-09-04, team=B1, not deleted), and real
// B1 jobs exist for that date -- but her employee portal's "My Jobs"
// schedule screen said "No jobs scheduled for tomorrow" anyway.
//
// Root cause: renderSchedule() computed the day's team from
// `currentEmployee.team` -- the employee's STATIC default team -- and
// never consulted the day-specific override at all. Melissa (hired via
// the job-application flow) has no default team_text/team_id whatsoever
// (both null; Tom places her day-by-day), so `team` was always '', and
// the jobs filter (`j.team === team`) could never match any real job on
// ANY day -- not tomorrow-specific, just never resolved a per-day
// override. Same bug class already fixed in the manager Hours views
// (PR #133/#134) but missed in this one screen.
//
// Fix: resolve via the existing global getEmployeeTeam(employeeId, dateStr)
// helper (index.html's `dailyAssignments`-backed one, not the internal
// PentaAssignments-module copy of the same name) for the VIEWED date --
// it already does override-then-default-team-then-null resolution
// correctly, including returning null (not the default team) for an
// explicit OFF day.
//
// Run with: node tests/emp-schedule-day-specific-team.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// Extract just the team-resolution snippet from renderSchedule() -- the
// function as a whole is a large DOM-rendering monolith not worth
// sandboxing wholesale; this is the exact logic that was wrong and that
// the fix touches.
const START = 'function renderSchedule() {';
const END = '\n  // Sprint 6.10: precompute employee\'s team color';
const s = src.indexOf(START);
if (s === -1) { console.error('FAIL: could not find renderSchedule()'); process.exit(1); }
const e = src.indexOf(END, s);
if (e === -1) { console.error('FAIL: could not find end boundary (team color comment)'); process.exit(1); }
const snippet = src.slice(s, e) + '\n  return team;\n}\n';

function resolveTeam(currentEmployee, getEmployeeTeamImpl, empSchedDate) {
  const sandbox = {
    console,
    currentEmployee: currentEmployee,
    _empSchedDate: empSchedDate || null,
    _empSchedStartOfDay: function(d) { var n = new Date(d); n.setHours(0,0,0,0); return n; },
    getEmployeeTeam: getEmployeeTeamImpl,
  };
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);
  return sandbox.renderSchedule();
}

// Melissa: no default team at all, but has a real B1 override for tomorrow.
const melissa = { id: '7a8465c8-8ae1-48f8-8657-bfe407f21091', team: null };
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);

check(
  'employee with NO default team but a day-specific override resolves to the override, not empty',
  resolveTeam(melissa, function(id, dateStr) {
    check('getEmployeeTeam called with the real employee id and the VIEWED date', !!id, true);
    return 'B1'; // simulates the dailyAssignments override for tomorrow
  }, tomorrow),
  'B1'
);

check(
  'employee with a normal default team and no override falls through correctly (getEmployeeTeam mirrors defaultTeam)',
  resolveTeam({ id: 'emp-2', team: 'B2' }, function() { return 'B2'; }, null),
  'B2'
);

check(
  'employee explicitly marked OFF for the viewed day resolves to empty, NOT their default team (no jobs should show)',
  resolveTeam({ id: 'emp-3', team: 'B2' }, function() { return null; }, tomorrow),
  ''
);

check(
  'defensive fallback: if getEmployeeTeam is unavailable, falls back to the static default (old behavior, not a regression)',
  resolveTeam({ id: 'emp-4', team: 'B3' }, undefined, null),
  'B3'
);

check(
  'no currentEmployee at all resolves to empty without throwing',
  resolveTeam(null, function() { return 'B1'; }, null),
  ''
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
