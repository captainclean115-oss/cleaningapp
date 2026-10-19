// REAL, CONFIRMED PRODUCTION BUG found during this task's investigation
// (not a hypothetical): terminateEmployee() flips status to
// 'terminated' via PentaEmployees.update() FIRST, which updates the
// in-memory facade cache synchronously, THEN looks up the employee via
// a BARE getUnifiedRoster() call to clear her default team. A bare
// call excludes anyone with status='terminated' regardless of date --
// so by the time that lookup ran, she was already excluded, and the
// "Clear the permanent team slot going forward" step (terminateEmployee's
// own stated intent) silently never executed.
//
// Confirmed live: Elvia Tonato (terminated 2026-08-19, status +
// terminated_at verified via a read-only query against the live
// database during this task) still has team_id/team_text = 'B1' in
// production today -- direct proof this bug was real, not theoretical.
//
// This test uses a REALISTIC getUnifiedRoster mock that actually models
// isTerminatedAsOf's bare-vs-dated exclusion (the existing
// employee-termination-flow.test.js mock does not -- it always returns
// the roster entry regardless of status or arguments, which is why that
// suite did not catch this).
//
// Run with: node tests/terminate-default-team-clear-regression.test.js

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

const setDefaultTeamSrc = extract(
  'async function _setEmployeeDefaultTeam(empId, newTeam) {',
  '\nasync function switchEmployeeWorkType(employeeUuid, newWorkType) {',
  '_setEmployeeDefaultTeam'
);
const terminateSrc = extract(
  'var TERMINATION_REASONS = [',
  '\nfunction editEmployeeAssignment(employeeId, dateStr) {',
  'terminateEmployee + rehireEmployee'
);
const fnSource = setDefaultTeamSrc + '\n' + terminateSrc;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox() {
  const state = { updateCalls: [], auditCalls: [], unassignFutureCalls: [] };
  // Mutable facade row, mutated in place by PentaEmployees.update --
  // models the real facade's _cache mutation-on-write behavior exactly.
  const facadeRow = { id: 'emp-uuid-1', uuid: 'emp-uuid-1', legacy_roster_id: 'roster-1', name: 'Elvia Tonato', team: 'B1', team_text: 'B1', status: 'active', terminated_at: null, role: [] };

  // REALISTIC getUnifiedRoster: models isTerminatedAsOf exactly as the
  // real function does -- a bare call (no asOfDate) excludes ANY
  // currently-terminated row, a dated call only excludes when
  // asOfDate >= terminated_at.
  function realisticGetUnifiedRoster(asOfDate) {
    const isTerminatedAsOf = facadeRow.status === 'terminated'
      && (!asOfDate ? true : (facadeRow.terminated_at ? asOfDate >= facadeRow.terminated_at : false));
    return isTerminatedAsOf ? [] : [{ id: facadeRow.legacy_roster_id, uuid: facadeRow.id, name: facadeRow.name, defaultTeam: facadeRow.team || facadeRow.team_text || null, role: [], work_type: 'field', fromFacade: true }];
  }

  const sandbox = {
    console,
    _ROSTER_ALL_HISTORY_ASOF: '0001-01-01',
    window: {
      supabaseClient: { auth: { getUser: function () { return Promise.resolve({ data: { user: { id: 'manager-uuid-1' } } }); } } },
      PentaEmployees: {
        update: function (id, patch) {
          state.updateCalls.push({ id: id, patch: patch });
          // Models the real facade: mutate the in-memory row SYNCHRONOUSLY
          // as part of the write, same as _fromRow(res.data) landing in
          // _cache before PentaEmployees.update() resolves.
          Object.assign(facadeRow, patch);
          return Promise.resolve({ id: id });
        },
      },
      PentaAssignments: {
        unassignFutureForEmployee: function (employeeId, fromDate) {
          state.unassignFutureCalls.push({ employeeId: employeeId, fromDate: fromDate });
          return Promise.resolve(0);
        },
      },
    },
    _auditSupplement: function (action_type, entity_type, entity_id, new_values) {
      state.auditCalls.push({ action_type: action_type, entity_type: entity_type, entity_id: entity_id, new_values: new_values });
      return Promise.resolve();
    },
    getUnifiedRoster: realisticGetUnifiedRoster,
    // _setEmployeeDefaultTeam's own body is part of this extraction --
    // it calls getUnifiedRoster(_ROSTER_ALL_HISTORY_ASOF) itself too, and
    // ultimately calls window.PentaEmployees.update, captured above.
    document: { getElementById: function () { return null; } },
    alert: function () {},
    confirm: function () { return true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, state: state, facadeRow: facadeRow };
}

async function main() {
  const { sandbox, state, facadeRow } = buildSandbox();

  const result = await sandbox.terminateEmployee('emp-uuid-1', {
    reason: 'voluntary_resignation', date: '2026-08-19', notes: '',
  });

  check('status flip itself still succeeds (the first write)', state.updateCalls[0].patch.status, 'terminated');

  // THE REGRESSION: a second PentaEmployees.update call clearing team_text/team_id.
  const teamClearCall = state.updateCalls.find(function (c) { return c.patch && (c.patch.team_text !== undefined || c.patch.team_id !== undefined); });
  check('a SEPARATE write actually clears team_text (the bug: this used to never happen)', !!teamClearCall, true);
  check('the team-clear write sets team_text to empty', teamClearCall && teamClearCall.patch.team_text, '');

  // Confirm via the facade row itself, mirroring exactly what the real
  // production query showed for Elvia BEFORE this fix (team_text/team_id
  // still 'B1' after termination -- here it must now be cleared).
  check('the in-memory facade row no longer shows the old team after termination (matches Elvia\'s real pre-fix bug, now fixed)', facadeRow.team_text, '');
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
}).then(function () {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
});
