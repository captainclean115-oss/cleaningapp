// Admin/Office employee designation (migration 113) -- roster
// filtering + the guard rails that keep an Admin employee out of
// field-team assignment paths.
//
// Covers, against the REAL extracted source (not a reimplementation):
//   1. getUnifiedRoster() carries work_type through on every facade row
//      (defaults to 'field' when the column is unset/legacy).
//   2. getTeamEmployees() excludes an Admin employee even if stray
//      daily-assignment data ever gave them a team (the defensive
//      second guard getJobDurationMins relies on).
//   3. quickAssign() refuses to assign a field team to an Admin
//      employee -- no write, a clear alert, no silent early-return
//      (console.warn first).
//   4. _setEmployeeDefaultTeam() refuses to SET a real team for an
//      Admin employee, but still allows CLEARING one (newTeam='') --
//      the exact call switchEmployeeWorkType itself makes.
//   5. switchEmployeeWorkType(): switching TO admin clears the default
//      team and purges future (not past) daily assignments; switching
//      back to field does neither, but always writes an audit entry
//      either direction.
//
// Run with: node tests/admin-work-type-roster-and-guards.test.js

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

// quickAssign + _setEmployeeDefaultTeam + switchEmployeeWorkType -- contiguous.
const guardsSrc = extract(
  'function quickAssign(empId, team, dateStr) {',
  '\n\n// PR #149 — employee termination/rehire flow.',
  'quickAssign + _setEmployeeDefaultTeam + switchEmployeeWorkType'
);
const rosterSrc = extract(
  'function getUnifiedRoster(asOfDate) {',
  '\n\n\n// Daily assignments',
  'getUnifiedRoster'
);
// Leading '\n' (no indent) is required here -- there's a second,
// unrelated, INDENTED getEmployeeTeam(employeeId, dateStr) nested
// inside a different facade module earlier in the file; without the
// anchor this marker finds that one instead and captures roughly the
// entire rest of the file up to the real assignEmployee().
const teamLookupSrc = extract(
  '\nfunction getEmployeeTeam(employeeId, dateStr) {',
  '\n\nasync function assignEmployee(',
  'getEmployeeTeam + getTeamEmployees'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const alerts = [];
  const facade = opts.facade || [
    { id: 'u-alice', legacy_roster_id: 'e1', name: 'Alice', team: 'B1', role: [], status: 'active', work_type: 'field' },
    { id: 'u-linda', legacy_roster_id: 'e2', name: 'Linda', team: null, team_text: null, role: [], status: 'active', work_type: 'admin' },
    { id: 'u-bob',   legacy_roster_id: 'e3', name: 'Bob',   team: null, team_text: null, role: [], status: 'active' }, // legacy row, no work_type column value at all
  ];
  const sandbox = {
    console,
    alert: function (msg) { alerts.push(msg); },
    confirm: function () { return true; },
    EMPLOYEE_ROSTER: [],
    window: {
      PentaEmployees: { listSync: function () { return facade; } },
      PentaAssignments: {
        unassignFutureForEmployee: function (uuid, fromDate) {
          calls.push(['unassignFutureForEmployee', uuid, fromDate]);
          return Promise.resolve(opts.removedCount != null ? opts.removedCount : 2);
        },
      },
      PentaTenant: { current: function () { return 'biz-1'; } },
      PentaTeams: { isLoaded: function () { return true; }, getByName: function () { return null; } },
    },
    dailyAssignments: opts.dailyAssignments || {},
    dailyAssignmentDetails: {},
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },
    dateKey: function (d) {
      var dt = (d instanceof Date) ? d : new Date(d);
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    },
    getEmployeeDayOffInfo: function (empId, dateStr) {
      var key = dateStr + '_' + empId;
      if (sandbox.dailyAssignments[key] !== 'OFF') return null;
      return sandbox.dailyAssignmentDetails[key] || null;
    },
    renderTeamManager: function () { calls.push(['renderTeamManager']); return Promise.resolve(); },
    recalcTeamTimes: function () { calls.push(['recalcTeamTimes']); },
    _hrsMaybeRefreshForDate: function () { calls.push(['_hrsMaybeRefreshForDate']); },
    assignEmployee: function (empId, team, dateStr) {
      calls.push(['assignEmployee', empId, team, dateStr]);
      var p = Promise.resolve();
      p.catch = function () { return p; }; // quickAssign chains .catch() on the result
      return p;
    },
    _auditSupplement: function (actionType, entityType, entityId, newValues) {
      calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    },
    PentaEmployees: { update: function () { return Promise.resolve(); } }, // bare global some call sites reference without window.
  };
  sandbox.window.PentaEmployees.update = sandbox.PentaEmployees.update;
  vm.createContext(sandbox);
  vm.runInContext(rosterSrc, sandbox);
  vm.runInContext(teamLookupSrc, sandbox);
  vm.runInContext(guardsSrc, sandbox);
  return { sandbox, calls, alerts };
}

async function main() {
  // ---- getUnifiedRoster carries work_type through ----
  {
    const { sandbox } = buildSandbox();
    const roster = sandbox.getUnifiedRoster();
    const linda = roster.find(function (e) { return e.name === 'Linda'; });
    const alice = roster.find(function (e) { return e.name === 'Alice'; });
    const bob = roster.find(function (e) { return e.name === 'Bob'; });
    check('Linda (work_type: admin) carries work_type=admin', linda && linda.work_type, 'admin');
    check('Alice (work_type: field) carries work_type=field', alice && alice.work_type, 'field');
    check('Bob (no work_type column value at all) defaults to field', bob && bob.work_type, 'field');
  }

  // ---- getTeamEmployees excludes an Admin employee even with a stray team override ----
  {
    const { sandbox } = buildSandbox({ dailyAssignments: { '2026-10-08_e2': 'B1' } }); // Linda somehow has a B1 override on file
    const b1 = sandbox.getTeamEmployees('B1', '2026-10-08');
    check('Linda does not show up in B1 despite the stray override (defensive guard)', b1.some(function (e) { return e.name === 'Linda'; }), false);
    check('Alice (a real B1 default) still shows up normally', b1.some(function (e) { return e.name === 'Alice'; }), true);
  }

  // ---- quickAssign refuses for an Admin employee ----
  {
    const { sandbox, calls, alerts } = buildSandbox();
    sandbox.quickAssign('e2', 'B1', '2026-10-08'); // Linda
    check('quickAssign never calls assignEmployee for an Admin employee', calls.some(function (c) { return c[0] === 'assignEmployee'; }), false);
    check('a clear alert explains why', alerts.some(function (a) { return /Admin\/Office/.test(a) && /Linda/.test(a); }), true);
  }
  {
    const { sandbox, calls } = buildSandbox();
    sandbox.quickAssign('e1', 'B1', '2026-10-08'); // Alice -- unaffected
    check('quickAssign still works normally for a field employee', calls.some(function (c) { return c[0] === 'assignEmployee' && c[1] === 'e1'; }), true);
  }

  // ---- _setEmployeeDefaultTeam refuses to SET a team for Admin, allows CLEARING ----
  {
    const { sandbox } = buildSandbox();
    const setResult = await sandbox._setEmployeeDefaultTeam('e2', 'B1'); // Linda -- trying to give her a real team
    check('setting a real default team for an Admin employee is refused', setResult, false);
  }
  {
    const { sandbox } = buildSandbox();
    const clearResult = await sandbox._setEmployeeDefaultTeam('e2', ''); // Linda -- clearing is fine
    check('clearing an Admin employee\'s default team is still allowed', clearResult, true);
  }

  // ---- switchEmployeeWorkType: to admin clears team + purges future assignments ----
  {
    const { sandbox, calls } = buildSandbox({ removedCount: 3 });
    const result = await sandbox.switchEmployeeWorkType('u-linda', 'admin');
    check('future daily assignments are purged from today forward', calls.some(function (c) { return c[0] === 'unassignFutureForEmployee' && c[1] === 'u-linda'; }), true);
    check('the purge count is returned', result.removedCount, 3);
    check('an audit_log entry is written documenting the switch', calls.some(function (c) { return c[0] === '_auditSupplement' && c[4].work_type === 'admin'; }), true);
  }

  // ---- switchEmployeeWorkType: back to field does NOT purge/clear anything ----
  {
    const { sandbox, calls } = buildSandbox();
    const result = await sandbox.switchEmployeeWorkType('u-linda', 'field');
    check('switching back to field does not purge any assignments', calls.some(function (c) { return c[0] === 'unassignFutureForEmployee'; }), false);
    check('removedCount is 0 for a field switch (nothing to purge)', result.removedCount, 0);
    check('an audit_log entry is still written either direction', calls.some(function (c) { return c[0] === '_auditSupplement' && c[4].work_type === 'field'; }), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
