// Tom: "live tracking is not reading geotab that quickly, lags a lot and
// has a continus 'loading data' at the top. i hit refresh and nothing
// happens too."
//
// PR #164 guarded the "↻ Refresh" button's own entry point
// (refreshLiveTab) against overlapping calls -- but window._autoRefreshInterval
// (every 2 minutes, while the GPS tab is open) calls loadGPSData()
// directly, and window._hoursLiveInterval (every 60s, while an open
// shift is active) calls loadWeekHours() directly -- both completely
// bypassing that guard. Confirmed live via the geotab-call edge
// function's own request logs: a steady burst of calls every ~2 minutes,
// all day, exactly matching the auto-refresh timer, not sporadic
// clicking. When that timer's own in-flight call overlapped with a
// manual "Refresh" click, both competed for the browser's same small
// per-host connection pool -- the exact pileup PR #164 fixed for the
// button, recurring through these other, unguarded entry points.
//
// Fix: move the in-flight guard down into loadGPSData()/loadWeekHours()
// themselves (each split into a thin guarded wrapper + a renamed inner
// implementation), so every caller -- the button, both auto-poll timers,
// gpsInit()'s own initial call -- is protected uniformly, not just
// refreshLiveTab().
//
// Run with: node tests/gps-hours-autopoll-inflight-guard.test.js

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
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

function extractWrapper(varMarker, fnMarker, endMarker) {
  const startIdx = src.indexOf(varMarker);
  if (startIdx === -1) { console.error('FAIL: could not find ' + varMarker); process.exit(1); }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) { console.error('FAIL: could not find end boundary after ' + fnMarker); process.exit(1); }
  return src.slice(startIdx, endIdx);
}

const gpsWrapperSrc = extractWrapper(
  'var _gpsDataLoadInFlight = false;',
  'async function loadGPSData()',
  '\nasync function _loadGPSDataInner()'
);
const hoursWrapperSrc = extractWrapper(
  'var _weekHoursLoadInFlight = false;',
  'async function loadWeekHours()',
  '\nasync function _loadWeekHoursInner()'
);

function buildSandbox(wrapperSrc, innerName, opts) {
  opts = opts || {};
  let resolveInner;
  const innerPromise = new Promise(function (r) { resolveInner = r; });
  const state = { innerCalls: 0 };
  const sandbox = { console };
  sandbox[innerName] = function () {
    state.innerCalls++;
    if (opts.innerThrows) return Promise.reject(new Error('inner boom'));
    return innerPromise;
  };
  vm.createContext(sandbox);
  vm.runInContext(wrapperSrc, sandbox);
  return { sandbox, state, resolveInner };
}

async function main() {
  // --- loadGPSData: the auto-interval-vs-button pileup scenario itself ---
  {
    const { sandbox, state, resolveInner } = buildSandbox(gpsWrapperSrc, '_loadGPSDataInner');
    // Simulates window._autoRefreshInterval firing while a previous cycle
    // (or a manual Refresh click) is still in flight.
    const p1 = sandbox.loadGPSData(); // e.g. the auto-poll timer
    await tick();
    const p2 = sandbox.loadGPSData(); // e.g. Tom's manual "Refresh" click landing mid-cycle
    await tick();
    check('a second overlapping call does NOT start a second inner load (no pileup)', state.innerCalls, 1);
    resolveInner();
    await Promise.all([p1, p2]);
    // After the in-flight cycle completes, a fresh call must work again --
    // this isn't a permanent lock, just a "don't pile up" guard.
    const p3 = sandbox.loadGPSData();
    await p3;
    check('a NEW call after the previous cycle finished starts its own fresh load', state.innerCalls, 2);
  }

  // --- loadGPSData: an error in the inner load must not leave the guard stuck ---
  {
    const { sandbox, state } = buildSandbox(gpsWrapperSrc, '_loadGPSDataInner', { innerThrows: true });
    const r1 = await sandbox.loadGPSData().then(function () { return { ok: true }; }, function (e) { return { ok: false, message: e.message }; });
    check('the failed call itself surfaces the real rejection (not swallowed)', r1, { ok: false, message: 'inner boom' });
    const r2 = await sandbox.loadGPSData().then(function () { return { ok: true }; }, function (e) { return { ok: false, message: e.message }; });
    check('after an inner failure, the guard resets (finally still runs) so the next call actually runs', state.innerCalls, 2);
    check('the second call also fails the same way (mock always throws) -- proves it actually re-ran, not just returned a cached result', r2, { ok: false, message: 'inner boom' });
  }

  // --- loadWeekHours: same pileup scenario (the 60s open-shift timer vs a manual click) ---
  {
    const { sandbox, state, resolveInner } = buildSandbox(hoursWrapperSrc, '_loadWeekHoursInner');
    const p1 = sandbox.loadWeekHours(); // e.g. window._hoursLiveInterval's 60s tick
    await tick();
    const p2 = sandbox.loadWeekHours(); // e.g. Tom's manual "Refresh" click
    await tick();
    check('loadWeekHours: a second overlapping call does NOT start a second inner load', state.innerCalls, 1);
    resolveInner();
    await Promise.all([p1, p2]);
    const p3 = sandbox.loadWeekHours();
    await p3;
    check('loadWeekHours: a NEW call after the previous cycle finished starts its own fresh load', state.innerCalls, 2);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
