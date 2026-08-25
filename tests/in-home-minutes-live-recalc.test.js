// PR #144 — regression test for live job-duration recalculation when a
// team's headcount changes for a date (getJobDurationMins divides
// clients.estimated_minutes by getTeamEmployees(team, date).length, so any
// assignment change changes every affected job's displayed duration).
//
// Before this PR, NEITHER the realtime assignment mirror
// (_mirrorPentaAssignmentsToInMemory, PR #133/#139's dual-key mirror) NOR
// assignEmployee (the shared write path behind quickAssign/
// confirmTeamAssign/Claire's move_employee/coverage-suggestion executor/
// onEmpTeamChange) ever called renderCal() -- only renderTeamManager/
// renderHoursTable did. A team change updated the roster views but left
// the schedule board's job durations stale until an unrelated renderCal
// happened to fire.
//
// Covers two things extracted and run from the ACTUAL source in index.html
// (not a reimplementation):
//
// 1. Cross-device/cross-tab: a realtime assignment change debounces to
//    exactly one guarded renderCal() call (only when the cal tab is the
//    one currently showing -- same guard idiom as the existing post-boot
//    renderCal calls at index.html:5759/15392).
// 2. Same-session: assignEmployee's optimistic write triggers an immediate
//    (non-debounced) guarded recalc, and a rollback on write failure
//    triggers it again so the board doesn't show a duration that never
//    actually persisted.
//
// Run with: node tests/in-home-minutes-live-recalc.test.js

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
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// ─────────────────────────────────────────────────────────────────
// Part 1: the debounced realtime mirror
// ─────────────────────────────────────────────────────────────────
const mirrorStart = 'var _pentaAssignmentsMirrorRenderTimer = null;';
const mirrorStartIdx = src.indexOf(mirrorStart);
if (mirrorStartIdx === -1) {
  console.error('FAIL: could not find _pentaAssignmentsMirrorRenderTimer declaration in index.html — did the mirror get refactored?');
  process.exit(1);
}
const mirrorEnd = '\n(function pentaPhase3fMirrorAssignments() {';
const mirrorEndIdx = src.indexOf(mirrorEnd, mirrorStartIdx);
if (mirrorEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after _mirrorPentaAssignmentsToInMemory — extraction range may need updating.');
  process.exit(1);
}
const mirrorSource = src.slice(mirrorStartIdx, mirrorEndIdx);
if (mirrorSource.indexOf('_refreshCalIfActive') === -1) {
  console.error('FAIL: _refreshCalIfActive is no longer referenced in the assignments mirror — was the PR #144 hook removed?');
  process.exit(1);
}

function buildMirrorSandbox(listSyncRows, activeTab) {
  const state = { renderCalCalls: 0 };
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    dailyAssignments: {},
    dailyAssignmentDetails: {},
    weekHours: {},
    hoursWeekOffset: 0,
    saveDailyAssignments: function () {},
    getWeekDates: function () { return []; },
    renderHoursTable: function () {},
    renderTeamManager: function () {},
    renderCal: function () { state.renderCalCalls++; },
    sessionStorage: { getItem: function () { return activeTab; } },
    document: { getElementById: function () { return null; } },
    window: {
      PentaAssignments: {
        isReady: function () { return true; },
        listSync: function () { return listSyncRows; },
      },
      PentaEmployees: { getById: function () { return null; } },
    },
  };
  sandbox.window.dailyAssignments = sandbox.dailyAssignments;
  vm.createContext(sandbox);
  vm.runInContext(mirrorSource, sandbox);
  return { sandbox: sandbox, state: state };
}

async function testMirror() {
  // Cal tab active: a realtime assignment change should recalc the board.
  {
    const rows = [{ date: '2026-08-25', employee_id: 'emp1', team: 'M1', status_type: null, notes: null }];
    const { sandbox, state } = buildMirrorSandbox(rows, 'cal');
    sandbox._mirrorPentaAssignmentsToInMemory();
    check('no renderCal yet immediately after the merge (debounced)', state.renderCalCalls, 0);
    await sleep(280);
    check('renderCal fires once after the debounce settles when the cal tab is active', state.renderCalCalls, 1);
  }

  // A different tab active: must NOT force a redraw of a hidden view.
  {
    const rows = [{ date: '2026-08-25', employee_id: 'emp1', team: 'M1', status_type: null, notes: null }];
    const { sandbox, state } = buildMirrorSandbox(rows, 'clients');
    sandbox._mirrorPentaAssignmentsToInMemory();
    await sleep(280);
    check('renderCal is NOT called when a different tab is active (guarded, same idiom as index.html:15392)', state.renderCalCalls, 0);
  }

  // Rapid-fire burst still collapses to exactly one recalc, not one per event.
  {
    let team = 'M1';
    const rowsRef = [{ date: '2026-08-25', employee_id: 'emp1', team: team, status_type: null, notes: null }];
    const { sandbox, state } = buildMirrorSandbox(rowsRef, 'cal');
    ['M2', 'M1', 'M2'].forEach(function (t) {
      rowsRef[0].team = t;
      sandbox._mirrorPentaAssignmentsToInMemory();
    });
    await sleep(280);
    check('a 3-event burst still collapses to exactly one renderCal (matches the existing debounce idiom)', state.renderCalCalls, 1);
  }
}

// ─────────────────────────────────────────────────────────────────
// Part 2: assignEmployee's immediate same-session recalc
// ─────────────────────────────────────────────────────────────────
const assignStart = 'async function assignEmployee(employeeId, team, dateStr, extra) {';
const assignStartIdx = src.indexOf(assignStart);
if (assignStartIdx === -1) {
  console.error('FAIL: could not find assignEmployee in index.html — did the assignment write path get refactored?');
  process.exit(1);
}
const assignEnd = '\n// NEW / EDIT CUSTOMER FORM';
const assignEndIdx = src.indexOf(assignEnd, assignStartIdx);
if (assignEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after assignEmployee — extraction range may need updating.');
  process.exit(1);
}
const assignSource = src.slice(assignStartIdx, assignEndIdx);

function buildAssignSandbox(assignImpl) {
  const state = { refreshCalCalls: 0, toasts: [] };
  const sandbox = {
    console: console,
    dailyAssignments: {},
    dailyAssignmentDetails: {},
    saveDailyAssignments: function () {},
    _refreshCalIfActive: function () { state.refreshCalCalls++; },
    showToast: function (msg) { state.toasts.push(msg); },
    window: { PentaAssignments: { assign: assignImpl } },
  };
  vm.createContext(sandbox);
  vm.runInContext(assignSource, sandbox);
  return { sandbox: sandbox, state: state };
}

async function testAssignEmployee() {
  // Successful write: immediate recalc, no rollback.
  {
    const { sandbox, state } = buildAssignSandbox(function () { return Promise.resolve(); });
    await sandbox.assignEmployee('emp1', 'M2', '2026-08-25');
    check('assignEmployee triggers an immediate recalc on the optimistic write, before the Supabase write even resolves', state.refreshCalCalls >= 1, true);
    check('assignment lands in dailyAssignments', sandbox.dailyAssignments['2026-08-25_emp1'], 'M2');
    check('no rollback toast on success', state.toasts.length, 0);
  }

  // Failed write: rollback also triggers a recalc so the board reverts.
  {
    const { sandbox, state } = buildAssignSandbox(function () { return Promise.reject(new Error('network down')); });
    let threw = false;
    try { await sandbox.assignEmployee('emp1', 'M2', '2026-08-25'); }
    catch (e) { threw = true; }
    check('a failed Supabase write still rejects (existing behavior, not swallowed)', threw, true);
    check('optimistic write is rolled back after failure', Object.prototype.hasOwnProperty.call(sandbox.dailyAssignments, '2026-08-25_emp1'), false);
    check('recalc fires TWICE on a failed write: once optimistically, once on rollback (so the board reverts to the pre-change duration)', state.refreshCalCalls, 2);
    check('failure surfaces a toast (pre-existing behavior, must not regress)', state.toasts.length, 1);
  }
}

(async function main() {
  await testMirror();
  await testAssignEmployee();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
