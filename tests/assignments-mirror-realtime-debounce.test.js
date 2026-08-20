// PR #139 — regression tests for the realtime-propagation side of the
// mobile-to-desktop assignment sync bug.
//
// Covers two things extracted and run from the ACTUAL
// _mirrorPentaAssignmentsToInMemory source in index.html (not a
// reimplementation):
//
// 1. Soft-delete correctness. PentaAssignments._hydrate() (and its
//    realtime cache) only ever holds ACTIVE rows (.is('deleted_at', null))
//    -- a soft-deleted row (e.g. the old B1 assignment, superseded by a
//    new S3 row on the same date/employee) is simply absent from
//    listSync(), never fetched "as deleted". This proves the mirror's
//    existing prune-on-absence step (PR #125) already produces the
//    correct end state from that active-only snapshot, without needing
//    to fetch soft-deleted rows at all.
//
// 2. Debounced realtime rendering. A single PentaAssignments.assign()
//    call produces TWO realtime events (soft-delete UPDATE + INSERT),
//    both of which reach every open tab. Before this PR, each one
//    re-rendered Team Manager synchronously (2 renders per assignment
//    change) and never touched the Live tab's Hours table at all. This
//    proves a rapid-fire cascade collapses into exactly ONE debounced
//    render of EACH (Team Manager + Hours table), matching the existing
//    _pentaJobsMirrorRenderTimer idiom (PR #101).
//
// Run with: node tests/assignments-mirror-realtime-debounce.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'var _pentaAssignmentsMirrorRenderTimer = null;';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find _pentaAssignmentsMirrorRenderTimer declaration in index.html — did the mirror get refactored?');
  process.exit(1);
}
const endMarker = '\n(function pentaPhase3fMirrorAssignments() {';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after _mirrorPentaAssignmentsToInMemory — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function buildSandbox(listSyncRows, hoursTableMounted) {
  const state = {
    dailyAssignments: { '2026-08-18_emp1': 'B1' }, // stale local entry from before the mobile move
    dailyAssignmentDetails: {},
    weekHours: { B1: { days: [0, 0, 0, 0, 0] }, S3: { days: [0, 0, 0, 0, 0] } },
    hoursWeekOffset: 0,
    renderTeamManagerCalls: 0,
    renderHoursTableCalls: 0,
    saveDailyAssignmentsCalls: 0,
  };

  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    dailyAssignments: state.dailyAssignments,
    dailyAssignmentDetails: state.dailyAssignmentDetails,
    weekHours: state.weekHours,
    hoursWeekOffset: state.hoursWeekOffset,
    saveDailyAssignments: function () { state.saveDailyAssignmentsCalls++; },
    getWeekDates: function () { return ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']; },
    renderHoursTable: function () { state.renderHoursTableCalls++; },
    renderTeamManager: function () { state.renderTeamManagerCalls++; },
    document: {
      getElementById: function (id) {
        if (id === 'hours-table') return hoursTableMounted ? {} : null;
        return null;
      },
    },
    window: {
      PentaAssignments: {
        isReady: function () { return true; },
        listSync: function () { return listSyncRows; },
      },
      PentaEmployees: {
        getById: function () { return null; }, // no legacy_roster_id aliasing needed for these cases
      },
    },
  };
  sandbox.window.dailyAssignments = sandbox.dailyAssignments;
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, state: state };
}

async function main() {
  // --- Test 1: soft-delete correctness via prune-on-absence ---
  // Old B1 row is soft-deleted server-side (absent from the active-only
  // listSync() snapshot); a new S3 row for the same date/employee is
  // active. The mirror must end up with S3, not a stale B1 leftover.
  {
    const rows = [{ date: '2026-08-18', employee_id: 'emp1', team: 'S3', status_type: null, notes: null }];
    const { sandbox } = buildSandbox(rows, false);
    sandbox._mirrorPentaAssignmentsToInMemory();
    check(
      'soft-deleted B1 row (absent from active listSync) is replaced by the new active S3 row, not left stale',
      sandbox.dailyAssignments['2026-08-18_emp1'],
      'S3'
    );
  }

  // --- Test 1b: a fully-removed assignment (no replacement) prunes to gone ---
  {
    const { sandbox } = buildSandbox([], false); // nothing active server-side at all
    sandbox._mirrorPentaAssignmentsToInMemory();
    check(
      'an assignment with no active replacement is pruned entirely (falls through to defaultTeam elsewhere), not left as stale B1',
      Object.prototype.hasOwnProperty.call(sandbox.dailyAssignments, '2026-08-18_emp1'),
      false
    );
  }

  // --- Test 2: debounced rendering on a realtime cascade ---
  // Simulates assign()'s two realtime echoes (soft-delete UPDATE, then
  // INSERT) landing back-to-back, plus the Live tab's Hours table being
  // mounted (document.getElementById('hours-table') truthy).
  {
    let team = 'B1';
    const rowsRef = [{ date: '2026-08-18', employee_id: 'emp1', team: team, status_type: null, notes: null }];
    const { sandbox, state } = buildSandbox(rowsRef, true);

    // Fire 3 rapid notifications, each changing the team so `merged` is
    // true every time (mirrors 3 realtime events landing in a burst).
    ['S3', 'B1', 'S3'].forEach(function (t) {
      rowsRef[0].team = t;
      sandbox._mirrorPentaAssignmentsToInMemory();
    });

    check('data merge is immediate: dailyAssignments already reflects the latest event synchronously', sandbox.dailyAssignments['2026-08-18_emp1'], 'S3');
    check('no render has fired yet immediately after a rapid 3-event burst (debounced)', { tm: state.renderTeamManagerCalls, hrs: state.renderHoursTableCalls }, { tm: 0, hrs: 0 });

    await sleep(280); // past the 200ms debounce window

    check('exactly ONE renderTeamManager() fires after the burst settles, not 3', state.renderTeamManagerCalls, 1);
    check('exactly ONE renderHoursTable() fires after the burst settles (Live tab now auto-updates on realtime)', state.renderHoursTableCalls, 1);
  }

  // --- Test 2b: Hours table refresh is skipped when the Live tab was never opened ---
  {
    const rows = [{ date: '2026-08-18', employee_id: 'emp1', team: 'S3', status_type: null, notes: null }];
    const { sandbox, state } = buildSandbox(rows, false); // hours-table not mounted
    sandbox._mirrorPentaAssignmentsToInMemory();
    await sleep(280);
    check('renderTeamManager still fires when the Hours table was never opened', state.renderTeamManagerCalls, 1);
    check('renderHoursTable is NOT called when the Hours table was never opened (nothing stale to fix)', state.renderHoursTableCalls, 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
