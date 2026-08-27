// PR #149 — regression tests for the employee termination/rehire
// orchestration functions (terminateEmployee, rehireEmployee) and the
// Terminate Employee modal's validation.
//
// Covers the spec's exact test-plan scenarios:
//   - reason='other' with no notes -> validation error, save blocked
//   - a valid termination writes status/terminated_at/termination_*/
//     eligible_for_rehire, clears the default team, purges future
//     daily_assignments (keeping past ones), and writes an audit entry
//   - rehire clears the termination_* fields but leaves eligible_for_rehire
//     untouched (per spec) and does not restore team/assignments
//
// Extracted and run from the ACTUAL source in index.html (not a
// reimplementation).
//
// Run with: node tests/employee-termination-flow.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'var TERMINATION_REASONS = [';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find TERMINATION_REASONS in index.html — did the termination flow get refactored?');
  process.exit(1);
}
const endMarker = '\nfunction editEmployeeAssignment(employeeId, dateStr) {';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after rehireEmployeeWithConfirm — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const state = {
    updateCalls: [], // { id, patch }
    auditCalls: [],  // { action_type, entity_type, entity_id, new_values }
    unassignFutureCalls: [],
    setDefaultTeamCalls: [],
  };
  const rosterEntry = opts.rosterEntry || { id: 'roster-1', uuid: 'emp-uuid-1', name: 'Jane Doe', defaultTeam: 'B1' };
  const sandbox = {
    console: console,
    window: {
      supabaseClient: {
        auth: { getUser: function () { return Promise.resolve({ data: { user: { id: 'manager-uuid-1' } } }); } },
      },
      PentaEmployees: {
        update: function (id, patch) { state.updateCalls.push({ id: id, patch: patch }); return Promise.resolve({ id: id }); },
      },
      PentaAssignments: {
        unassignFutureForEmployee: function (employeeId, fromDate) {
          state.unassignFutureCalls.push({ employeeId: employeeId, fromDate: fromDate });
          return Promise.resolve(opts.futureAssignmentCount != null ? opts.futureAssignmentCount : 2);
        },
      },
    },
    _auditSupplement: function (action_type, entity_type, entity_id, new_values) {
      state.auditCalls.push({ action_type: action_type, entity_type: entity_type, entity_id: entity_id, new_values: new_values });
      return Promise.resolve();
    },
    getUnifiedRoster: function () { return [rosterEntry]; },
    _setEmployeeDefaultTeam: function (id, team) { state.setDefaultTeamCalls.push({ id: id, team: team }); return Promise.resolve(true); },
    getMainEmpList: function () { return opts.list || [rosterEntry]; },
    getStaffList: function () { return opts.list || [rosterEntry]; },
    renderMainEmployees: function () { state.rerenderedMain = true; },
    renderStaffList: function () { state.rerenderedStaffList = true; },
    renderStaffSubview: function () { state.rerenderedStaffSubview = true; },
    showToast: function (msg) { state.toasts = state.toasts || []; state.toasts.push(msg); },
    document: { getElementById: function () { return null; } },
    alert: function (msg) { state.alerts = state.alerts || []; state.alerts.push(msg); },
    confirm: function (msg) { state.confirmCalls = state.confirmCalls || []; state.confirmCalls.push(msg); return opts.confirmReturns !== undefined ? opts.confirmReturns : true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, state: state };
}

async function main() {
  // --- Validation: reason='other' with no notes blocks the save ---
  {
    const { sandbox, state } = buildSandbox();
    let threw = null;
    try {
      await sandbox.terminateEmployee('emp-uuid-1', { reason: 'other', date: '2026-08-27', notes: '' });
    } catch (e) { threw = e; }
    check('reason=other with no notes throws a validation error', !!threw, true);
    check('no PentaEmployees.update call happens when validation fails', state.updateCalls.length, 0);
  }

  // --- Validation: missing reason / missing date ---
  {
    const { sandbox } = buildSandbox();
    let threwNoReason = null;
    try { await sandbox.terminateEmployee('emp-uuid-1', { date: '2026-08-27' }); } catch (e) { threwNoReason = e; }
    check('missing reason throws', !!threwNoReason, true);

    let threwNoDate = null;
    try { await sandbox.terminateEmployee('emp-uuid-1', { reason: 'layoff' }); } catch (e) { threwNoDate = e; }
    check('missing date throws', !!threwNoDate, true);
  }

  // --- Happy path: valid termination writes everything the spec requires ---
  {
    const { sandbox, state } = buildSandbox({ futureAssignmentCount: 3 });
    const result = await sandbox.terminateEmployee('emp-uuid-1', {
      reason: 'termination_performance', date: '2026-08-27', notes: 'Missed 3 shifts', eligibleForRehire: false,
    });
    check('exactly one PentaEmployees.update call', state.updateCalls.length, 1);
    const patch = state.updateCalls[0].patch;
    check('sets status=terminated', patch.status, 'terminated');
    check('sets terminated_at to the chosen date', patch.terminated_at, '2026-08-27');
    check('sets termination_reason', patch.termination_reason, 'termination_performance');
    check('sets termination_notes', patch.termination_notes, 'Missed 3 shifts');
    check('sets terminated_by to the current user', patch.terminated_by, 'manager-uuid-1');
    check('sets eligible_for_rehire', patch.eligible_for_rehire, false);
    check('does NOT set deleted_at (termination ≠ deletion, see migration 104)', Object.prototype.hasOwnProperty.call(patch, 'deleted_at'), false);

    check('clears the default team via the existing dual-write-safe path', state.setDefaultTeamCalls, [{ id: 'roster-1', team: '' }]);
    check('purges future daily_assignments from the termination date', state.unassignFutureCalls, [{ employeeId: 'emp-uuid-1', fromDate: '2026-08-27' }]);

    check('writes a terminated audit log entry', state.auditCalls.length, 1);
    check('audit entry uses action_type=terminated, entity_type=employee', { a: state.auditCalls[0].action_type, e: state.auditCalls[0].entity_type }, { a: 'terminated', e: 'employee' });
    check('audit entry carries the reason and future-removal count', { reason: state.auditCalls[0].new_values.reason, removed: state.auditCalls[0].new_values.future_assignments_removed }, { reason: 'termination_performance', removed: 3 });
    check('terminateEmployee resolves with the removed count', result.removedCount, 3);
  }

  // --- reason='other' WITH notes succeeds ---
  {
    const { sandbox, state } = buildSandbox();
    await sandbox.terminateEmployee('emp-uuid-1', { reason: 'other', date: '2026-08-27', notes: 'Moved out of state' });
    check('reason=other with notes provided succeeds', state.updateCalls.length, 1);
  }

  // --- eligibleForRehire defaults to true when omitted ---
  {
    const { sandbox, state } = buildSandbox();
    await sandbox.terminateEmployee('emp-uuid-1', { reason: 'layoff', date: '2026-08-27' });
    check('eligible_for_rehire defaults to true', state.updateCalls[0].patch.eligible_for_rehire, true);
  }

  // --- Rehire: clears termination_* fields, leaves eligible_for_rehire untouched ---
  {
    const { sandbox, state } = buildSandbox();
    await sandbox.rehireEmployee('emp-uuid-1');
    check('exactly one PentaEmployees.update call', state.updateCalls.length, 1);
    const patch = state.updateCalls[0].patch;
    check('sets status back to active', patch.status, 'active');
    check('clears terminated_at', patch.terminated_at, null);
    check('clears termination_reason', patch.termination_reason, null);
    check('clears termination_notes', patch.termination_notes, null);
    check('clears terminated_by', patch.terminated_by, null);
    check('does NOT touch eligible_for_rehire (not in the spec\'s clear list)', Object.prototype.hasOwnProperty.call(patch, 'eligible_for_rehire'), false);
    check('does NOT touch team_id/team_text (admin re-adds if needed, per spec)', Object.prototype.hasOwnProperty.call(patch, 'team_id'), false);
    check('writes a rehired audit log entry', state.auditCalls[0].action_type, 'rehired');
  }

  // --- rehireEmployeeWithConfirm: eligible_for_rehire=true skips the warning ---
  {
    const entry = { id: '11111111-1111-4111-8111-111111111111', name: 'Bo Ng', eligible_for_rehire: true };
    const { sandbox, state } = buildSandbox({ list: [entry] });
    await sandbox.rehireEmployeeWithConfirm(0, 'main');
    check('eligible_for_rehire=true: no confirm() warning shown', state.confirmCalls, undefined);
    check('eligible_for_rehire=true: rehire proceeds (PentaEmployees.update called)', state.updateCalls.length, 1);
    check('re-renders the main employee list on success', state.rerenderedMain, true);
  }

  // --- rehireEmployeeWithConfirm: eligible_for_rehire=false requires an explicit override ---
  {
    const entry = { id: '22222222-2222-4222-8222-222222222222', name: 'Cal Ito', eligible_for_rehire: false, termination_notes: 'No-call no-show twice' };
    const { sandbox, state } = buildSandbox({ list: [entry], confirmReturns: true });
    await sandbox.rehireEmployeeWithConfirm(0, 'staff');
    check('eligible_for_rehire=false: shows a confirm() warning', state.confirmCalls.length, 1);
    check('warning includes the termination notes as the reason', state.confirmCalls[0].indexOf('No-call no-show twice') !== -1, true);
    check('user confirming the override proceeds with rehire', state.updateCalls.length, 1);
  }

  // --- rehireEmployeeWithConfirm: cancelling the override aborts, no write happens ---
  {
    const entry = { id: '33333333-3333-4333-8333-333333333333', name: 'Dee Park', eligible_for_rehire: false, termination_notes: 'Policy violation' };
    const { sandbox, state } = buildSandbox({ list: [entry], confirmReturns: false });
    await sandbox.rehireEmployeeWithConfirm(0, 'staff');
    check('cancelling the not-eligible warning blocks the rehire entirely', state.updateCalls.length, 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
