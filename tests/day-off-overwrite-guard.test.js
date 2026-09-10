// Bug report: "Setting vacation status for Aug 31 doesn't render on the
// UI. Employee's Aug 31 cell still shows normal hours or blank instead of
// 'Vacation' label."
//
// Confirmed via live DB query (daily_assignments for the real employee/
// date): a status_type='vacation' row WAS created, then soft-deleted
// ~10 minutes later when a plain team='B3' row was created for the same
// employee/date, both by the same account. The render code was never
// broken -- by the time the cell was viewed, the data genuinely said
// "B3", not vacation, because it had been overwritten.
//
// Root cause: an employee with an active Day-Off status has no resolved
// team for that date (getEmployeeTeam deliberately returns null for
// OFF), so they show up in the Team Manager's "Unassigned employees"
// list -- right next to one-tap team-assign pills (quickAssign) -- and
// the team picker modal's own team buttons (confirmTeamAssign) have the
// same gap. assignEmployee/assign() unconditionally soft-deletes any
// existing row once the team differs, with no special case for "the
// existing row was a Day-Off status" -- so a single stray tap on either
// path silently erases it with zero confirmation.
//
// Fix: both quickAssign() and confirmTeamAssign() now check
// getEmployeeDayOffInfo() first and, if the employee is currently marked
// off, ask for confirmation before writing a plain team over it.
//
// Run with: node tests/day-off-overwrite-guard.test.js

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

function extract(startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) { console.error('FAIL: could not find start marker ' + startMarker); process.exit(1); }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) { console.error('FAIL: could not find end marker ' + endMarker); process.exit(1); }
  return src.slice(startIdx, endIdx);
}

const quickAssignSrc = extract('function quickAssign(empId, team, dateStr) {', '\nasync function promptDefaultTeam(');
const confirmTeamAssignSrc = extract('function confirmTeamAssign(employeeId, dateStr, team, overlay, extra) {', '\n// EMPLOYEE ROSTER');

const DAY_OFF_CATEGORY_LABELS = {
  vacation: 'Vacation',
  excused_absence: 'Excused absence',
  unexcused_absence: 'Unexcused absence',
  no_call_no_show: 'No call / no show',
  not_scheduled: 'Not scheduled'
};

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const confirmPrompts = [];
  const roster = [{ id: 'emp-1', name: 'Etelvina Cabral' }];
  const sandbox = {
    console,
    DAY_OFF_CATEGORY_LABELS: DAY_OFF_CATEGORY_LABELS,
    getEmployeeDayOffInfo: function (empId, dateStr) {
      return opts.dayOffInfo || null;
    },
    getEmployeeTeam: function (empId, dateStr) {
      return opts.oldTeam != null ? opts.oldTeam : null;
    },
    getUnifiedRoster: function () { return roster; },
    confirm: function (msg) {
      confirmPrompts.push(msg);
      return opts.confirmReturns != null ? opts.confirmReturns : true;
    },
    assignEmployee: function (empId, team, dateStr, extra) {
      calls.push(['assignEmployee', empId, team, dateStr, extra]);
      return Promise.resolve({ id: 'row-1' });
    },
    renderTeamManager: function () { calls.push(['renderTeamManager']); },
    recalcTeamTimes: function () { calls.push(['recalcTeamTimes']); },
    _hrsMaybeRefreshForDate: function () { calls.push(['_hrsMaybeRefreshForDate']); },
    logPendingUpdate: function () { calls.push(['logPendingUpdate']); },
  };
  vm.createContext(sandbox);
  vm.runInContext(quickAssignSrc, sandbox);
  vm.runInContext(confirmTeamAssignSrc, sandbox);
  return { sandbox, calls, confirmPrompts };
}

function fakeOverlay() {
  const calls = [];
  return { remove: function () { calls.push('removed'); }, _calls: calls };
}

async function main() {
  // quickAssign: employee is NOT marked off -- no confirmation prompt,
  // write proceeds exactly as before (no regression for the common case).
  {
    const { sandbox, calls, confirmPrompts } = buildSandbox({ dayOffInfo: null });
    sandbox.quickAssign('emp-1', 'B3', '2026-08-31');
    check('no confirm prompt when the employee is not off', confirmPrompts.length, 0);
    check('assignEmployee is called normally', calls.some(c => c[0] === 'assignEmployee'), true);
  }

  // quickAssign: employee IS marked vacation -- must confirm before
  // writing, and the message must name the actual category.
  {
    const { sandbox, calls, confirmPrompts } = buildSandbox({ dayOffInfo: { status_type: 'vacation', notes: null } });
    sandbox.quickAssign('emp-1', 'B3', '2026-08-31');
    check('a confirm prompt is shown', confirmPrompts.length, 1);
    check('the prompt names the employee and the Vacation label', /Etelvina Cabral/.test(confirmPrompts[0]) && /Vacation/.test(confirmPrompts[0]), true);
    check('assignEmployee still runs once confirmed (default mock returns true)', calls.some(c => c[0] === 'assignEmployee'), true);
  }

  // quickAssign: employee is marked vacation and the user declines --
  // the write must NOT happen. This is the exact scenario that silently
  // overwrote Etelvina's Aug 31 vacation status.
  {
    const { sandbox, calls, confirmPrompts } = buildSandbox({ dayOffInfo: { status_type: 'vacation', notes: null }, confirmReturns: false });
    sandbox.quickAssign('emp-1', 'B3', '2026-08-31');
    check('confirm was asked', confirmPrompts.length, 1);
    check('assignEmployee is NOT called when the user declines', calls.some(c => c[0] === 'assignEmployee'), false);
    check('no other side effects run either', calls.length, 0);
  }

  // confirmTeamAssign: same guard, via the team-picker modal's team
  // buttons. Not off -- no prompt, proceeds normally.
  {
    const { sandbox, calls, confirmPrompts } = buildSandbox({ dayOffInfo: null });
    const overlay = fakeOverlay();
    sandbox.confirmTeamAssign('emp-1', '2026-08-31', 'B3', overlay);
    check('no confirm prompt when not off', confirmPrompts.length, 0);
    check('assignEmployee runs normally', calls.some(c => c[0] === 'assignEmployee'), true);
    check('overlay closes on the normal success path', overlay._calls.includes('removed'), true);
  }

  // confirmTeamAssign: marked off, user declines -- must bail before any
  // write AND before the overlay is torn down (leave the modal open so
  // the user can make a deliberate choice instead).
  {
    const { sandbox, calls, confirmPrompts } = buildSandbox({ dayOffInfo: { status_type: 'unexcused_absence', notes: null }, confirmReturns: false });
    const overlay = fakeOverlay();
    sandbox.confirmTeamAssign('emp-1', '2026-08-31', 'B3', overlay);
    check('a confirm prompt is shown naming Unexcused absence', confirmPrompts.some(m => /Unexcused absence/.test(m)), true);
    check('assignEmployee is NOT called when declined', calls.some(c => c[0] === 'assignEmployee'), false);
    check('the overlay is left open (not force-closed) when declined', overlay._calls.includes('removed'), false);
  }

  // confirmTeamAssign: picking a Day-Off category itself (team === 'OFF')
  // must NEVER be guarded -- that's the intentional override path
  // (e.g. correcting Unexcused -> Excused) and must not be blocked by
  // its own category's presence.
  {
    const { sandbox, calls, confirmPrompts } = buildSandbox({ dayOffInfo: { status_type: 'unexcused_absence', notes: null } });
    const overlay = fakeOverlay();
    sandbox.confirmTeamAssign('emp-1', '2026-08-31', 'OFF', overlay, { status_type: 'excused_absence', notes: null });
    check('no confirm prompt when picking a Day-Off category over an existing one', confirmPrompts.length, 0);
    check('assignEmployee runs to apply the category change', calls.some(c => c[0] === 'assignEmployee'), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
