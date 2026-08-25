// PR #145 — regression test for jobDragEnd() losing a job's duration on drag.
//
// Before this fix, jobDragEnd updated job.time to the drop point but left
// job.endTime at its stale pre-drag absolute clock value. getJobDurationMins()
// treats `job.endTime && job.time` as an unconditional override over the
// minutes/headcount calc, so a stale endTime silently corrupted the
// displayed duration on the very next render (e.g. a 9:00-11:00 job dragged
// to 11:00 kept showing endTime 11:00 -- zero/negative duration -- instead
// of shifting to 13:00).
//
// Extracted and run from the ACTUAL jobDragEnd source in index.html (not a
// reimplementation). Drag-state module vars and DOM/facade collaborators
// are stubbed, matching the existing test convention.
//
// Run with: node tests/job-drag-end-time-preserved.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'function jobDragEnd(e) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find jobDragEnd in index.html — did the drag handler get refactored?');
  process.exit(1);
}
const endMarker = '\n\n// ── DRIVE TIME BETWEEN JOBS ──';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after jobDragEnd — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(job, snappedMins) {
  const state = { updatePayload: null, recalcArgs: null, savedJobsCalls: 0 };
  const fakeEl = { style: {}, removeAttribute: function(){}, getAttribute: function(){ return null; }, parentElement: null };
  const sandbox = {
    console: console,
    clearTimeout: function () {},
    jobDragMove: function () {},
    navigator: { vibrate: function () {} },
    document: {
      removeEventListener: function () {},
      body: { style: {} },
      elementFromPoint: function () { return fakeEl; },
      querySelectorAll: function () { return []; },
      getElementById: function (id) { return id === 'tl-main-scroll' ? null : null; },
    },
    _dragActive: true,
    _dragJob: job,
    _dragEl: { style: {} },
    _dragClone: null,
    _dragTimer: null,
    _dragOffsetX: 0,
    _dragSnappedMins: snappedMins,
    _dragPoint: function () { return { x: 0, y: 0 }; },
    saveJobs: function () { state.savedJobsCalls++; },
    window: {
      PentaJobs: {
        update: function (id, patch) { state.updatePayload = { id: id, patch: patch }; return Promise.resolve(); },
      },
    },
    recalcTeamTimes: function (team, date, id) { state.recalcArgs = { team: team, date: date, id: id }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  sandbox.jobDragEnd({ clientX: 0, clientY: 0 });
  return { sandbox: sandbox, state: state };
}

// --- Acceptance criteria: a 2-hour job dragged from 9:00 to 11:00 -> ends at 13:00 ---
{
  const job = { id: 'j1', date: '2026-08-25', team: 'M1', time: '09:00', endTime: '11:00', flexible: false };
  const { state } = buildSandbox(job, 11 * 60); // snapped to 11:00
  check('start time moves to the drop point', job.time, '11:00');
  check('end time shifts by the same delta, preserving the original 2-hour duration', job.endTime, '13:00');
  check('the corrected endTime is included in the Supabase dual-write, not just the in-memory object', state.updatePayload.patch.endTime, '13:00');
}

// --- Dragging earlier still preserves duration ---
{
  const job = { id: 'j2', date: '2026-08-25', team: 'M1', time: '13:00', endTime: '14:30', flexible: false };
  buildSandbox(job, 9 * 60); // dragged back to 9:00, original duration 90 min
  check('dragging a job EARLIER still preserves its original duration', job.endTime, '10:30');
}

// --- Drag across midnight wraps instead of producing an invalid clock time ---
{
  const job = { id: 'j3', date: '2026-08-25', team: 'M1', time: '22:00', endTime: '23:00', flexible: false };
  buildSandbox(job, 23 * 60 + 30); // dragged to 23:30, 1-hour duration wraps past midnight
  check('a duration that wraps past midnight produces a valid wrapped clock time, not an out-of-range hour', job.endTime, '00:30');
}

// --- A job with no endTime (flexible/never had one) is left alone, no crash ---
{
  const job = { id: 'j4', date: '2026-08-25', team: 'M1', time: '10:00', flexible: true };
  buildSandbox(job, 12 * 60);
  check('a job with no pre-existing endTime is not given a fabricated one', job.endTime, undefined);
}

// --- No time change (e.g. only dropped on a different team row) leaves endTime untouched ---
{
  const job = { id: 'j5', date: '2026-08-25', team: 'M1', time: '09:00', endTime: '11:00', flexible: false };
  buildSandbox(job, null); // no snap, and no tl-main-scroll in this stub -> time branch never runs
  check('when the time genuinely does not change, endTime is left as-is (no spurious recompute)', job.endTime, '11:00');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
