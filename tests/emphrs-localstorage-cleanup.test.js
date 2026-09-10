// PR #172 -- one-time cleanup of stale empHrs_* localStorage keys left
// over from before migration 110 / PentaHourOverrides moved manual hour
// overrides to Supabase (PR #171). getEmpHours/saveEmpHours/
// clearEmpHours no longer read or write this key shape at all, so
// anything still there is dead weight and (on a browser that had
// accumulated many of them) was the confirmed direct cause of the
// "hitting quota limits" report.
//
// PR #173 -- Tom asked not to touch any of his 11 pre-migration entries
// so he can review each one himself. The original PR #172 version
// deleted them outright, which would have silently destroyed exactly
// that data on his browser's next load. Archive instead of delete: move
// each key to an _empHrs_archived_ prefix instead of removing it --
// still clears the active empHrs_* namespace, but nothing is lost.
//
// Run with: node tests/emphrs-localstorage-cleanup.test.js

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

const startMarker = "// PR #172/#173 -- one-time cleanup.";
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find the PR #172/#173 cleanup block'); process.exit(1); }
const endMarker = "\n})();\n\n// PR #119's cleanup";
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find the cleanup block end boundary'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx + '\n})();'.length);

function fakeLocalStorage(initial) {
  var store = Object.assign({}, initial);
  return {
    _store: store,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: function (i) { return Object.keys(store)[i] || null; },
  };
}

function run(initial) {
  const logs = [];
  const sandbox = { console: { log: function (m) { logs.push(m); }, warn: console.warn, error: console.error } };
  sandbox.localStorage = fakeLocalStorage(initial);
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { localStorage: sandbox.localStorage, logs };
}

// A browser with several stale overrides plus unrelated keys that must survive.
{
  const { localStorage, logs } = run({
    'empHrs_e_1785880510271_2026-08-03': '{"start":"09:00"}',
    'empHrs_e_1778494837214_2026-08-05': '{"start":"08:00"}',
    'weekHours_cache': '{"B1":{}}',
    'cleanco_pending': '[]',
  });
  check('both stale empHrs_* keys are gone from the active namespace', Object.keys(localStorage._store).filter(k => k.indexOf('empHrs_') === 0).length, 0);
  check('their DATA is preserved under the archived prefix, not deleted', localStorage.getItem('_empHrs_archived_e_1785880510271_2026-08-03'), '{"start":"09:00"}');
  check('their DATA is preserved under the archived prefix, not deleted (2)', localStorage.getItem('_empHrs_archived_e_1778494837214_2026-08-05'), '{"start":"08:00"}');
  check('unrelated keys survive untouched', localStorage.getItem('weekHours_cache'), '{"B1":{}}');
  check('unrelated keys survive untouched (2)', localStorage.getItem('cleanco_pending'), '[]');
  check('the completion flag is set so this only runs once', localStorage.getItem('_pr172_emphrs_localstorage_cleanup_done'), '1');
  check('an archive count was logged (not a "removed" count)', logs.some(l => /archived 2 stale/.test(l)), true);
}

// Re-running (simulating the next page load) must be a no-op -- the
// guard flag prevents re-scanning, and nothing throws if it does run
// again on an already-clean store.
{
  const { localStorage, logs } = run({ '_pr172_emphrs_localstorage_cleanup_done': '1', 'empHrs_should_never_be_touched_1': '{}' });
  check('a key that appears AFTER the guard flag is set is left alone (guard short-circuits)', localStorage.getItem('empHrs_should_never_be_touched_1'), '{}');
  check('nothing is logged on the guarded no-op path', logs.length, 0);
}

// A browser with no stale keys at all -- must not log a spurious count.
{
  const { localStorage, logs } = run({ 'weekHours_cache': '{}' });
  check('flag is still set even when nothing needed archiving', localStorage.getItem('_pr172_emphrs_localstorage_cleanup_done'), '1');
  check('nothing is logged when there was nothing to archive', logs.length, 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
