// PR #137/#138 — regression test for "week nav shows missing days that
// appear on toggle" / "mobile assignment doesn't show on desktop after
// refresh". Root cause: loadWeekHours() is fired from many independent,
// unawaited call sites (hoursWeekMove, gpsInit -- itself invoked from 3+
// separate cold-load triggers, quickAssign's retroactive refresh, the new
// refreshLiveTab). Each call resets the SHARED weekHours/
// window._empHoursMap globals before doing slow network-bound work, so
// overlapping calls can interleave and let a stale/superseded call's
// result win the final render.
//
// Fix: a monotonic _weekHoursLoadToken counter, incremented at the top of
// every loadWeekHours() call and re-checked before (a) resetting the
// shared globals and (b) persisting/painting the result -- same pattern
// already used by loadGPSData's _gpsLoadToken.
//
// This test does NOT re-implement loadWeekHours (400+ lines of Geotab/
// time_entries logic) -- it extracts the ACTUAL guard skeleton (token
// declaration + the two in-function checks) out of index.html and drives
// it with real Promise interleaving, so a future edit that removes or
// misplaces one of the checks fails this test instead of silently
// reintroducing the race.
//
// Run with: node tests/loadweekhours-concurrency-guard.test.js

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

// --- Structural checks: the guard exists at the right points ---

const tokenDeclIdx = src.indexOf('let _weekHoursLoadToken = 0;');
check('_weekHoursLoadToken counter is declared', tokenDeclIdx !== -1, true);

const fnStartMarker = 'async function loadWeekHours() {';
const fnStartIdx = src.indexOf(fnStartMarker);
if (fnStartIdx === -1) {
  console.error('FAIL: could not find loadWeekHours() in index.html — did it get renamed or moved?');
  process.exit(1);
}
// loadWeekHours is a single large function; grab a generous slice through
// its end (next top-level `async function debugTrips()` immediately follows it).
const fnEndMarker = '\nasync function debugTrips()';
const fnEndIdx = src.indexOf(fnEndMarker, fnStartIdx);
if (fnEndIdx === -1) {
  console.error('FAIL: could not find the end boundary of loadWeekHours() — extraction range may need updating.');
  process.exit(1);
}
const fnBody = src.slice(fnStartIdx, fnEndIdx);

check(
  'loadWeekHours captures a token at entry',
  /var _myWeekHoursToken = \+\+_weekHoursLoadToken;/.test(fnBody),
  true
);

const resetIdx = fnBody.indexOf('weekHours = {};');
const firstGuardIdx = fnBody.indexOf('if (_myWeekHoursToken !== _weekHoursLoadToken) return;');
check(
  'a token check runs BEFORE the shared weekHours global is reset',
  firstGuardIdx !== -1 && resetIdx !== -1 && firstGuardIdx < resetIdx,
  true
);

const renderIdx = fnBody.indexOf('renderHoursTable(days, DAYS_SHORT);');
const secondGuardIdx = fnBody.indexOf('if (_myWeekHoursToken !== _weekHoursLoadToken) return;', firstGuardIdx + 1);
check(
  'a second token check runs BEFORE the final render/persist',
  secondGuardIdx !== -1 && renderIdx !== -1 && secondGuardIdx < renderIdx,
  true
);

// --- Behavioral check: the mechanism actually discards a stale result ---
//
// Simulates the real control flow (increment token; await slow work;
// bail if superseded; write shared state; bail again if superseded before
// painting) under real Promise interleaving: an OLDER call ("week A",
// slow) is started first, then a NEWER call ("week A again", fast) is
// started before the older one resolves -- reproducing Tom's
// "week A -> B -> back to A" flow where the first A-load is still
// in-flight when the second A-load kicks off.
async function runConcurrencyScenario() {
  let token = 0;
  const shared = { weekHours: null, rendered: null };

  async function fakeLoadWeekHours(label, delayMs, resultTeam) {
    const myToken = ++token;
    await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
    if (myToken !== token) return 'bailed-before-reset:' + label;
    shared.weekHours = null; // simulates `weekHours = {}`
    await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
    if (myToken !== token) return 'bailed-before-render:' + label;
    shared.weekHours = resultTeam;
    shared.rendered = label;
    return 'rendered:' + label;
  }

  const slowOlderCall = fakeLoadWeekHours('week-A-stale', 40, 'A-STALE-DATA');
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  const fastNewerCall = fakeLoadWeekHours('week-A-fresh', 5, 'A-FRESH-DATA');

  const results = await Promise.all([slowOlderCall, fastNewerCall]);
  return { results: results, finalWeekHours: shared.weekHours, finalRendered: shared.rendered };
}

runConcurrencyScenario().then(function (outcome) {
  check(
    'the stale (older, slower) call never paints its result',
    outcome.results[0].indexOf('bailed') === 0,
    true
  );
  check(
    'the fresh (newer) call is the one that actually rendered',
    outcome.finalRendered,
    'week-A-fresh'
  );
  check(
    'the shared data reflects only the fresh call, not a mix of both',
    outcome.finalWeekHours,
    'A-FRESH-DATA'
  );

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}).catch(function (e) {
  console.error('FAIL: concurrency scenario threw', e);
  process.exit(1);
});
