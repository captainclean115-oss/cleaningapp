// PR #140 — regression tests for "Move Employee / Day Off modal buttons
// unreliable" (Tom: tap does nothing most of the time; retapping often
// doesn't help either; both mobile Safari/Chrome and desktop).
//
// Root cause found by code review, not live device testing (no headless
// browser was available in this sandbox): confirmTeamAssign -- the single
// write path BOTH modals funnel through (team buttons in
// editEmployeeAssignment, day-off category buttons in
// _showDayOffCategoryPicker) -- ran logPendingUpdate() FIRST, synchronously
// and unguarded, before the user-visible response (overlay.remove() +
// the optimistic renderTeamManager() repaint). logPendingUpdate's
// localStorage write (cleanco_pending, via savePending) had no cap and no
// try/catch, so a QuotaExceededError after months of real accumulated
// pending-update entries would abort the rest of confirmTeamAssign before
// the modal ever closed -- a plain JS exception, not a touch-event quirk,
// so it explains the desktop symptom too. The same bloated array persists
// across a retap, so retrying hit the identical throw.
//
// Fixed by (1) reordering confirmTeamAssign so the modal-close + repaint
// happen first and unconditionally, with every non-essential side effect
// wrapped in try/catch after, and (2) hardening savePending() itself with
// a cap + try/catch at the source, matching logActivity's existing
// pattern. This test extracts the REAL confirmTeamAssign and savePending
// source from index.html and exercises both.
//
// Run with: node tests/confirm-team-assign-feedback-isolation.test.js

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

// ---- Extract confirmTeamAssign ----
const ctaStart = 'function confirmTeamAssign(employeeId, dateStr, team, overlay, extra) {';
const ctaStartIdx = src.indexOf(ctaStart);
if (ctaStartIdx === -1) {
  console.error('FAIL: could not find confirmTeamAssign in index.html — did it get renamed or moved?');
  process.exit(1);
}
const ctaEndMarker = '\n\n\n// ─────────────────────────────────────────\n// EMPLOYEE ROSTER';
const ctaEndIdx = src.indexOf(ctaEndMarker, ctaStartIdx);
if (ctaEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after confirmTeamAssign — extraction range may need updating.');
  process.exit(1);
}
const ctaSource = src.slice(ctaStartIdx, ctaEndIdx);

// Anchor on the actual call site (logPendingUpdate(emp.name...), not the
// bare function name -- this file's own explanatory comment above the
// fix mentions "logPendingUpdate()" in prose, which would otherwise
// false-match an earlier index than the real call.
const logPendingUpdateCallIdx = ctaSource.indexOf('logPendingUpdate(emp.name');
check('the real logPendingUpdate(emp.name...) call site was found', logPendingUpdateCallIdx !== -1, true);
check(
  'overlay.remove() appears before the logPendingUpdate call in source order',
  ctaSource.indexOf('overlay.remove();') < logPendingUpdateCallIdx,
  true
);
check(
  'renderTeamManager({ skipMirror: true }) appears before the logPendingUpdate call in source order',
  ctaSource.indexOf("renderTeamManager({ skipMirror: true })") < logPendingUpdateCallIdx,
  true
);
check(
  'logPendingUpdate is wrapped in try/catch',
  /try\s*\{\s*logPendingUpdate\(/.test(ctaSource),
  true
);

function buildConfirmTeamAssignSandbox(opts) {
  const calls = { overlayRemoved: false, renderTeamManagerCalls: 0, logPendingUpdateCalled: false, recalcTeamTimesCalled: false, hrsRefreshCalled: false };
  const overlay = { remove: function () { calls.overlayRemoved = true; } };
  const sandbox = {
    console: console,
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },
    getUnifiedRoster: function () { return [{ id: 'emp1', name: 'Keyshla' }]; },
    getEmployeeTeam: function () { return 'B1'; },
    assignEmployee: function () { return Promise.resolve({}); },
    logPendingUpdate: function () {
      calls.logPendingUpdateCalled = true;
      if (opts.throwOnLogPendingUpdate) throw new Error('QuotaExceededError (simulated)');
    },
    recalcTeamTimes: function () {
      calls.recalcTeamTimesCalled = true;
      if (opts.throwOnRecalc) throw new Error('simulated recalc failure');
    },
    _hrsMaybeRefreshForDate: function () {
      calls.hrsRefreshCalled = true;
      if (opts.throwOnHoursRefresh) throw new Error('simulated hours-refresh failure');
    },
    renderTeamManager: function () { calls.renderTeamManagerCalls++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(ctaSource, sandbox);
  return { sandbox: sandbox, calls: calls, overlay: overlay };
}

// --- Behavioral: even when EVERY downstream side effect throws, the
// modal still closes and the grid still repaints. This is the actual
// bug fix -- proving it holds even under a worse-than-observed failure
// combination, not just the specific QuotaExceededError case. ---
{
  const { sandbox, calls, overlay } = buildConfirmTeamAssignSandbox({
    throwOnLogPendingUpdate: true, throwOnRecalc: true, throwOnHoursRefresh: true,
  });
  sandbox.confirmTeamAssign('emp1', '2026-08-20', 'S3', overlay, null);
  check('modal closes even when logPendingUpdate/recalcTeamTimes/_hrsMaybeRefreshForDate ALL throw', calls.overlayRemoved, true);
  check('grid still repaints even when every downstream side effect throws', calls.renderTeamManagerCalls, 1);
  check('logPendingUpdate was still attempted (not skipped, just isolated)', calls.logPendingUpdateCalled, true);
}

// --- Sanity: normal (non-throwing) path still does everything ---
{
  const { sandbox, calls, overlay } = buildConfirmTeamAssignSandbox({});
  sandbox.confirmTeamAssign('emp1', '2026-08-20', 'S3', overlay, null);
  check('normal path: modal closes', calls.overlayRemoved, true);
  check('normal path: grid repaints', calls.renderTeamManagerCalls, 1);
  check('normal path: logPendingUpdate runs', calls.logPendingUpdateCalled, true);
  check('normal path: recalcTeamTimes runs', calls.recalcTeamTimesCalled, true);
  check('normal path: hours refresh runs', calls.hrsRefreshCalled, true);
}

// --- The !emp guard is no longer a silent dead end ---
{
  const { sandbox, calls, overlay } = buildConfirmTeamAssignSandbox({});
  sandbox.getUnifiedRoster = function () { return []; }; // employee not found
  sandbox.confirmTeamAssign('missing-emp', '2026-08-20', 'S3', overlay, null);
  check('unknown employeeId still closes the modal instead of leaving it stuck open', calls.overlayRemoved, true);
}

// ---- Extract savePending ----
const spStart = 'function savePending() {';
const spStartIdx = src.indexOf(spStart);
if (spStartIdx === -1) {
  console.error('FAIL: could not find savePending in index.html — did it get renamed or moved?');
  process.exit(1);
}
const spEndIdx = src.indexOf('\n}\n', spStartIdx) + 3;
const capDeclIdx = src.lastIndexOf('var PENDING_UPDATES_DONE_CAP', spStartIdx);
if (capDeclIdx === -1) {
  console.error('FAIL: could not find PENDING_UPDATES_DONE_CAP declaration before savePending.');
  process.exit(1);
}
const capDeclLineEnd = src.indexOf('\n', capDeclIdx) + 1;
const spSource = src.slice(capDeclIdx, capDeclLineEnd) + src.slice(spStartIdx, spEndIdx);

function buildSavePendingSandbox(pendingUpdatesArr, throwOnSetItem) {
  const state = { stored: null, updateTaskBadgeCalls: 0 };
  const sandbox = {
    console: console,
    pendingUpdates: pendingUpdatesArr,
    updateTaskBadge: function () { state.updateTaskBadgeCalls++; },
    localStorage: {
      setItem: function (k, v) {
        if (throwOnSetItem) throw new Error('QuotaExceededError (simulated)');
        state.stored = v;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(spSource, sandbox);
  return { sandbox: sandbox, state: state };
}

// --- A quota failure inside savePending itself no longer throws uncaught ---
{
  const { sandbox, state } = buildSavePendingSandbox([{ id: '1', done: false }], true);
  let threw = false;
  try { sandbox.savePending(); } catch (e) { threw = true; }
  check('savePending() no longer throws uncaught when localStorage.setItem fails', threw, false);
  check('updateTaskBadge still runs even after a storage failure', state.updateTaskBadgeCalls, 1);
}

// --- Capping: all not-done entries are preserved, done entries are capped ---
{
  const active = [];
  for (let i = 0; i < 10; i++) active.push({ id: 'active' + i, done: false });
  const done = [];
  for (let i = 0; i < 500; i++) done.push({ id: 'done' + i, done: true }); // newest-first, matches unshift() order
  const { sandbox, state } = buildSavePendingSandbox(active.concat(done), false);
  sandbox.savePending();
  const stored = JSON.parse(state.stored);
  const storedActive = stored.filter(function (p) { return !p.done; });
  const storedDone = stored.filter(function (p) { return p.done; });
  check('all 10 not-done (still-actionable) entries survive capping, none silently dropped', storedActive.length, 10);
  check('done entries are capped at PENDING_UPDATES_DONE_CAP (200), not left to grow to 500', storedDone.length, 200);
  check('the KEPT done entries are the most recent ones (newest-first order preserved)', storedDone[0].id, 'done0');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
