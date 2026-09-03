// Tom: "i hit refresh data and takes forever to load and gets stuck
// loading fleet data." Root cause: _gpsLoadToken/_weekHoursLoadToken only
// guard which result gets RENDERED when overlapping loads finish out of
// order -- they never stopped the underlying Geotab fetches themselves
// from running. Every click of "Refresh" fired a brand new full round of
// _geotabCall()s regardless of whether a previous round was still in
// flight. Confirmed live: Geotab itself answered a realistic week-wide
// Trip query in well under a second (directly tested), and the account's
// geotab-call rate-limit bucket was nowhere near its 600/hr ceiling -- so
// the "stuck for a long time" symptom wasn't Geotab being slow, it was
// dozens of piled-up in-flight requests (from repeated clicking) queued
// behind the browser's small per-host connection limit, with each one
// still running to completion (or its own 30s timeout) even though its
// result would just be discarded on arrival.
//
// Fix: refreshLiveTab() now no-ops on a repeat click while a previous
// call is still in flight, and visibly disables the button + shows
// "Refreshing…" instead of silently accepting (and piling up) another
// full round underneath.
//
// Run with: node tests/refresh-live-tab-inflight-guard.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function tick() { return new Promise(function (r) { setImmediate(r); }); }

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const startMarker = 'var _refreshLiveTabInFlight = false;';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find _refreshLiveTabInFlight declaration'); process.exit(1); }
const endMarker = '\n\nasync function loadGPSData() {';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find refreshLiveTab end boundary'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx);

function buildSandbox(opts) {
  opts = opts || {};
  const calls = { gps: 0, hours: 0, assignHydrate: 0, empHydrate: 0 };
  const btn = { disabled: false, style: {}, textContent: '↻ Refresh' };
  let resolveGps, resolveHours;
  const gpsPromise = new Promise(function (r) { resolveGps = r; });
  const hoursPromise = new Promise(function (r) { resolveHours = r; });

  const sandbox = {
    console,
    document: { getElementById: function (id) { return id === 'gps-refresh-btn' ? btn : null; } },
    window: {
      PentaAssignments: { _hydrate: function () { calls.assignHydrate++; return Promise.resolve(); } },
      PentaEmployees: { _hydrate: function () { calls.empHydrate++; return Promise.resolve(); } },
    },
    loadGPSData: function () {
      calls.gps++;
      if (opts.gpsRejects) return Promise.reject(new Error('gps boom'));
      return gpsPromise;
    },
    loadWeekHours: function () {
      calls.hours++;
      if (opts.hoursRejects) return Promise.reject(new Error('hours boom'));
      return hoursPromise;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, calls, btn, resolveGps, resolveHours };
}

async function main() {
  // A single call runs both loaders once, disables the button while busy,
  // and restores it once both complete.
  {
    const { sandbox, calls, btn, resolveGps, resolveHours } = buildSandbox();
    const p = sandbox.refreshLiveTab();
    await tick(); // let the async function run past its intermediate awaits (PentaAssignments/PentaEmployees hydrate) up to loadGPSData/loadWeekHours
    check('button is disabled while a refresh is in flight', btn.disabled, true);
    check('button shows a busy label while in flight', btn.textContent, '↻ Refreshing…');
    resolveGps(); resolveHours();
    await p;
    check('loadGPSData called exactly once', calls.gps, 1);
    check('loadWeekHours called exactly once', calls.hours, 1);
    check('button re-enabled after completion', btn.disabled, false);
    check('button label restored after completion', btn.textContent, '↻ Refresh');
  }

  // Repeat clicks while busy are no-ops -- this is the actual fix. Before
  // this, N rapid clicks fired N full rounds of Geotab calls that piled
  // up; now only the first click's round runs.
  {
    const { sandbox, calls, resolveGps, resolveHours } = buildSandbox();
    const p1 = sandbox.refreshLiveTab();
    await Promise.resolve();
    const p2 = sandbox.refreshLiveTab();
    const p3 = sandbox.refreshLiveTab();
    await tick();
    check('repeat clicks while busy do NOT start additional loadGPSData rounds', calls.gps, 1);
    check('repeat clicks while busy do NOT start additional loadWeekHours rounds', calls.hours, 1);
    resolveGps(); resolveHours();
    await Promise.all([p1, p2, p3]);
  }

  // After a refresh completes, a NEW click works again (flag correctly resets).
  {
    const { sandbox, calls, resolveGps, resolveHours } = buildSandbox();
    resolveGps(); resolveHours();
    await sandbox.refreshLiveTab();
    resolveGps(); resolveHours(); // no-op re-resolves, promises already settled
    await sandbox.refreshLiveTab();
    check('a second refresh AFTER the first completes runs its own new round', calls.gps, 2);
    check('a second refresh AFTER the first completes runs its own new round (hours)', calls.hours, 2);
  }

  // A failure in one of the loaders must not leave the guard stuck true
  // forever (finally block resets it even on rejection).
  {
    const { sandbox, btn, resolveHours } = buildSandbox({ gpsRejects: true });
    resolveHours(); // the other loader still needs to settle for Promise.all to resolve
    await sandbox.refreshLiveTab();
    check('button re-enabled even after loadGPSData rejects (finally still runs)', btn.disabled, false);
    check('refreshLiveTab itself does not throw when a loader rejects (caught internally)', true, true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
