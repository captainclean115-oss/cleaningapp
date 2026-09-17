// Bug report: "Setting employee OFF for a day stops working after 1-2
// successful clicks." Tom's hypothesis was the same class as PR #140
// (confirmTeamAssign's unbounded logPendingUpdate write). That specific
// mechanism was checked and is confirmed still fixed (see
// confirm-team-assign-feedback-isolation.test.js, 18/18 passing) --
// savePending()/logActivity() are both already capped + try/catch
// hardened, and neither confirmTeamAssign nor quickAssign call
// logPendingUpdate/recalcTeamTimes/hours-refresh unguarded any more
// (PR #140, PR #178).
//
// No headless browser was available in this sandbox to reproduce live
// (same limitation noted in PR #140's and PR #178's own test files), so
// this fix is by code review: reading the actual write path both the
// "Move to team" buttons and the "Day Off" picker funnel through
// (confirmTeamAssign -> assignEmployee -> saveDailyAssignments), not by
// re-deriving the reported symptom from scratch.
//
// Real gap found: saveDailyAssignments() -- the local optimistic-write
// persist step every single team/OFF assignment goes through -- was
// completely unguarded, and (unlike logPendingUpdate/logActivity) its
// call inside assignEmployee sits OUTSIDE that function's own
// try/catch (which only wraps the `await window.PentaAssignments.assign`
// line). A QuotaExceededError there -- from daily_assignments itself, or
// from ANY other key sharing the same per-origin quota (emp_forms,
// emp_signatures, and several raw cleanco_tasks/cleanco_pending writes
// found unguarded elsewhere in this sweep all keep growing forever with
// no cap) -- threw straight out of assignEmployee BEFORE it ever reached
// the real Supabase write. Since assignEmployee is `async`, that throw
// became a rejected promise instead of an uncaught exception, so it
// didn't freeze the UI -- but confirmTeamAssign/quickAssign's
// `writePromise.catch()` only re-renders, it doesn't toast (that's
// assignEmployee's OWN catch, which this bypassed entirely) -- so the
// real write silently never happened, with zero visible feedback,
// exactly matching "tap does nothing, no error, refresh doesn't help
// until whatever was filling the quota clears." Once local storage is
// near its quota, EVERY subsequent tap can hit the same throw --
// explains "works 1-2 times, then stops."
//
// Fixed by hardening saveDailyAssignments() itself (non-fatal try/catch,
// matching savePending/saveManualTasks/logActivity's already-established
// pattern) so a storage failure there can never again abort the rest of
// assignEmployee before the real network write is attempted.
//
// Run with: node tests/save-daily-assignments-quota-isolation.test.js

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

// ---- Extract saveDailyAssignments ----
const sdaStart = 'function saveDailyAssignments() {';
const sdaStartIdx = src.indexOf(sdaStart);
if (sdaStartIdx === -1) {
  console.error('FAIL: could not find saveDailyAssignments in index.html -- did it get renamed or moved?');
  process.exit(1);
}
// Its closing brace is the first '\n}\n' after the start (single small function).
const sdaEndIdx = src.indexOf('\n}\n', sdaStartIdx) + 2;
const sdaSource = src.slice(sdaStartIdx, sdaEndIdx);

// ---- Extract assignEmployee ----
const aeStart = 'async function assignEmployee(employeeId, team, dateStr, extra) {';
const aeStartIdx = src.indexOf(aeStart);
if (aeStartIdx === -1) {
  console.error('FAIL: could not find assignEmployee in index.html -- did it get renamed or moved?');
  process.exit(1);
}
const aeEndMarker = '\n\n\n// ─────────────────────────────────────────';
const aeEndIdx = src.indexOf(aeEndMarker, aeStartIdx);
if (aeEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after assignEmployee -- extraction range may need updating.');
  process.exit(1);
}
const aeSource = src.slice(aeStartIdx, aeEndIdx);

// Sanity: assert the fix shape is actually present in the extracted source
// (not just that the functions exist) -- guards against this test passing
// vacuously if someone reverts the fix without touching these boundaries.
if (!/function saveDailyAssignments\(\) \{\s*try \{/.test(sdaSource)) {
  console.error('FAIL: saveDailyAssignments does not appear to wrap its write in try/catch -- fix may have been reverted.');
  process.exit(1);
}

function runScenario(opts) {
  const dailyAssignments = {};
  const dailyAssignmentDetails = {};
  const warnings = [];
  const toasts = [];
  const store = {}; // fake localStorage backing
  const fakeLocalStorage = {
    getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function(k, v) {
      if (opts.quotaExceededFor && opts.quotaExceededFor(k)) {
        throw new Error('QuotaExceededError (simulated)');
      }
      store[k] = v;
    }
  };

  let assignCalled = false;
  const fakePentaAssignments = {
    assign: async function(dateStr, team, employeeId, extra) {
      assignCalled = true;
      if (opts.assignFails) throw new Error('network write failed (simulated)');
      return { id: 'row1', date: dateStr, team: team, employee_id: employeeId };
    }
  };

  const sandbox = {
    dailyAssignments: dailyAssignments,
    dailyAssignmentDetails: dailyAssignmentDetails,
    localStorage: fakeLocalStorage,
    window: { PentaAssignments: fakePentaAssignments },
    _refreshCalIfActive: function() {},
    showToast: function(msg, type) { toasts.push({ msg: msg, type: type }); },
    console: { warn: function(msg) { warnings.push(String(msg)); }, log: function(){}, error: function(){} },
  };
  vm.createContext(sandbox);
  vm.runInContext(sdaSource + '\n' + aeSource, sandbox);

  return { sandbox: sandbox, assignCalledRef: () => assignCalled, warnings: warnings, toasts: toasts, dailyAssignments: dailyAssignments };
}

(async function() {
  // Scenario 1: daily_assignments write throws (quota exceeded on THIS
  // key, or any other key sharing the same origin's storage budget --
  // simulated the same way either way, since setItem itself is what throws).
  // Before the fix: this exception escaped assignEmployee before the
  // Supabase write was ever attempted. After the fix: it's swallowed and
  // the real write still happens.
  {
    const ctx = runScenario({ quotaExceededFor: (k) => k === 'daily_assignments' });
    try {
      await ctx.sandbox.assignEmployee('emp1', 'OFF', '2026-09-17', { status_type: 'vacation', notes: null });
      check('assign() on PentaAssignments is still attempted despite a saveDailyAssignments quota failure', ctx.assignCalledRef(), true);
      check('the optimistic OFF write is applied in memory even though it could not persist locally', ctx.dailyAssignments['2026-09-17_emp1'], 'OFF');
      check('saveDailyAssignments logs a non-fatal warning instead of throwing', ctx.warnings.some(w => w.indexOf('[saveDailyAssignments]') === 0), true);
    } catch (e) {
      fail++; console.log('  FAIL scenario 1 threw uncaught: ' + e.message);
    }
  }

  // Scenario 2: repeat the same tap 10 times in a row (matches the "tap
  // OFF 10 times" verification Tom asked for) -- every single one must
  // still reach the real write attempt, none should get stuck partway.
  {
    const ctx = runScenario({ quotaExceededFor: (k) => k === 'daily_assignments' });
    let calls = 0;
    const origAssign = ctx.sandbox.window.PentaAssignments.assign;
    ctx.sandbox.window.PentaAssignments.assign = async function() { calls++; return origAssign.apply(this, arguments); };
    for (let i = 0; i < 10; i++) {
      await ctx.sandbox.assignEmployee('emp' + i, 'OFF', '2026-09-17', { status_type: 'vacation', notes: null });
    }
    check('all 10 taps reach the Supabase write attempt, not just the first 1-2', calls, 10);
  }

  // Scenario 3: saveDailyAssignments still writes normally when there is
  // no quota problem -- the fix must not turn off persistence outright.
  {
    const ctx = runScenario({ quotaExceededFor: () => false });
    await ctx.sandbox.assignEmployee('emp1', 'OFF', '2026-09-17', { status_type: 'vacation', notes: null });
    const persisted = JSON.parse(ctx.sandbox.localStorage.getItem('daily_assignments') || '{}');
    check('a normal (non-quota-exceeded) write still persists to localStorage', persisted['2026-09-17_emp1'], 'OFF');
  }

  // Scenario 4: the actual Supabase write failing (unrelated to local
  // storage) still rolls back + toasts exactly as before -- confirms the
  // fix didn't touch that existing, already-correct behavior.
  {
    const ctx = runScenario({ quotaExceededFor: () => false, assignFails: true });
    let threw = false;
    try {
      await ctx.sandbox.assignEmployee('emp1', 'OFF', '2026-09-17', { status_type: 'vacation', notes: null });
    } catch (e) { threw = true; }
    check('a real Supabase write failure still rejects (so callers roll back)', threw, true);
    check('a real Supabase write failure still rolls back the optimistic in-memory write', ctx.dailyAssignments['2026-09-17_emp1'], undefined);
    check('a real Supabase write failure still shows the existing toast', ctx.toasts.length === 1 && ctx.toasts[0].type === 'error', true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
