// PR #160 follow-up -- PR #160 fixed renderSchedule() (employee portal's
// "My Jobs" screen) to resolve the VIEWED day's team via getEmployeeTeam()
// instead of the employee's static default. That data comes from the
// dailyAssignments mirror (_mirrorPentaAssignmentsToInMemory, populated
// from PentaAssignments). But nothing told renderSchedule() to re-run once
// that mirror pass actually completed -- so an employee who opened the
// schedule tab BEFORE the mirror finished (very plausible right after
// being placed on a team for the first time, especially with no default
// team to fall back to -- e.g. Melissa Manna) saw the empty state and
// stayed there even after the real override data arrived a moment later.
// Confirmed live: Tom reported "still showing no schedule for her for
// tomorrow" even after PR #160 deployed, with the daily_assignments row
// and the 3 real B1 jobs both already correct server-side.
//
// The PentaJobs mirror already solved this exact problem for job data
// (v10.5.5, see pentaPhase4MirrorHydrate in index.html) -- this extends
// the same "re-render the schedule tab, debounced, only if it's actually
// open" treatment to the assignments mirror.
//
// Covers extraction from the ACTUAL _mirrorPentaAssignmentsToInMemory
// source in index.html, same boundaries as
// assignments-mirror-realtime-debounce.test.js (that file covers the
// pre-existing renderTeamManager/renderHoursTable behavior; this one is
// scoped to the new renderSchedule() hook only).
//
// Run with: node tests/emp-schedule-rerender-on-assignments-mirror.test.js

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

function buildSandbox(opts) {
  opts = opts || {};
  const inPortal = opts.inPortal !== false; // default true
  const schedTabVisible = opts.schedTabVisible !== false; // default true
  const state = { renderScheduleCalls: 0 };

  const els = {
    'hours-table': null,
    'tab-schedule': schedTabVisible ? { offsetParent: {} } : (opts.schedTabMissing ? null : { offsetParent: null }),
  };

  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    dailyAssignments: {},
    dailyAssignmentDetails: {},
    saveDailyAssignments: function () {},
    renderTeamManager: function () {},
    renderSchedule: function () { state.renderScheduleCalls++; },
    document: {
      body: { classList: { contains: function (c) { return c === 'in-portal' && inPortal; } } },
      getElementById: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; },
    },
    window: {
      PentaAssignments: {
        isReady: function () { return true; },
        listSync: function () { return opts.rows || [{ date: '2026-09-04', employee_id: 'emp-uuid-1', team: 'B1', status_type: null, notes: null }]; },
      },
      PentaEmployees: {
        getById: function (id) {
          if (id !== 'emp-uuid-1') return null;
          return { id: 'emp-uuid-1', legacy_roster_id: 'app_796a8946' };
        },
      },
    },
  };
  sandbox.window.dailyAssignments = sandbox.dailyAssignments;
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, state: state };
}

async function main() {
  // Schedule tab open, in portal: renderSchedule fires after the debounce.
  {
    const { sandbox, state } = buildSandbox({});
    sandbox._mirrorPentaAssignmentsToInMemory();
    check('no render fires synchronously (debounced)', state.renderScheduleCalls, 0);
    await sleep(280);
    check('renderSchedule fires once the mirror settles, with the schedule tab open in-portal', state.renderScheduleCalls, 1);
  }

  // Rapid-fire cascade (3 events) collapses to exactly one renderSchedule call.
  {
    const rows = [{ date: '2026-09-04', employee_id: 'emp-uuid-1', team: 'B1', status_type: null, notes: null }];
    const { sandbox, state } = buildSandbox({ rows: rows });
    ['S3', 'B1', 'S3'].forEach(function (t) {
      rows[0].team = t;
      sandbox._mirrorPentaAssignmentsToInMemory();
    });
    await sleep(280);
    check('a 3-event burst collapses into exactly ONE renderSchedule call, not 3', state.renderScheduleCalls, 1);
  }

  // Not in the employee portal at all (manager session): must not fire.
  {
    const { sandbox, state } = buildSandbox({ inPortal: false });
    sandbox._mirrorPentaAssignmentsToInMemory();
    await sleep(280);
    check('renderSchedule does NOT fire when the session is not in-portal (manager view)', state.renderScheduleCalls, 0);
  }

  // In portal, but the schedule tab isn't the one currently open/visible.
  {
    const { sandbox, state } = buildSandbox({ schedTabVisible: false });
    sandbox._mirrorPentaAssignmentsToInMemory();
    await sleep(280);
    check('renderSchedule does NOT fire when the schedule tab exists but is not visible (offsetParent null)', state.renderScheduleCalls, 0);
  }

  // Schedule tab element not even in the DOM (a different portal tab entirely).
  {
    const { sandbox, state } = buildSandbox({ schedTabMissing: true, schedTabVisible: false });
    sandbox._mirrorPentaAssignmentsToInMemory();
    await sleep(280);
    check('renderSchedule does NOT fire (and nothing throws) when #tab-schedule is absent from the DOM', state.renderScheduleCalls, 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
