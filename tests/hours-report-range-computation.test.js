// _computeHoursForDateRange(dates) -- the slow-path computation Export
// Hours Report uses when the picked range doesn't match the Hours
// tab's currently-loaded week (last week, a rolling window, a custom
// range). Generalizes _loadWeekHoursInner's per-day depot/job-crossref/
// lunch algorithm to an arbitrary list of dates, batching ONE Geotab
// trip fetch across every device for the WHOLE range (not one fetch
// per day -- the Live tab supports ranges up to 30 days).
//
// Extracts the real algorithm chain verbatim (same functions
// _loadWeekHoursInner itself calls) and runs it against synthetic
// multi-team, multi-day Geotab data, mocking only the true I/O
// boundaries (isDepotAddress/isDepotPoint/matchStopToClientGeo,
// _geotabCall, _resolveTeamDeviceMap, reverseGeocodeTrips) -- same
// convention as tests/lunch-detection-bounded.test.js and
// tests/archived-overrides-gps-comparison.test.js.
//
// Run with: node tests/hours-report-range-computation.test.js

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

function extract(startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) { console.error('FAIL: could not find end marker after ' + startMarker); process.exit(1); }
  return src.slice(startIdx, endIdx);
}

const algoSrc = extract('function _findTrueDepotDepartureTrip(', '\nasync function loadWeekHours()');
const bizWallClockSrc = extract('function _bizWallClockToUtc(', '\n\n// Returns { fromDate, toDate,');
const computeSrc = extract('async function _computeHoursForDateRange(dates) {', '\n\n// Actual text/CSV builder');

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const sandbox = {
    console, Intl,
    window: { PentaLunchFlags: null },
    jobs: opts.jobs || [],
    isDepotAddress: function (addr) { return addr === 'DEPOT'; },
    isDepotPoint: function () { return false; },
    matchStopToClientGeo: function () { return null; },
    _pentaBusinessTimezone: function () { return 'America/New_York'; },
    _pentaTeamNames: function () { return opts.teams || ['B1', 'B3']; },
    _geotabCall: function (method, params) {
      calls.push(['_geotabCall', method]);
      if (params.typeName === 'Device') return Promise.resolve(opts.devices || [{ id: 'dev-b1' }, { id: 'dev-b3' }]);
      if (params.typeName === 'Trip') return Promise.resolve(opts.trips || []);
      return Promise.resolve([]);
    },
    _resolveTeamDeviceMap: function (devices, teamOrder, dateObj) {
      var dk = dateObj.toISOString().slice(0, 10);
      calls.push(['_resolveTeamDeviceMap', dk]);
      var map = {};
      teamOrder.forEach(function (t) {
        var override = opts.deviceByTeamDate && opts.deviceByTeamDate[t + '_' + dk];
        map[t] = override !== undefined ? override : (opts.defaultDeviceByTeam ? opts.defaultDeviceByTeam[t] : { device: { id: 'dev-' + t.toLowerCase() } });
      });
      return Promise.resolve(map);
    },
    reverseGeocodeTrips: function (trips) { return Promise.resolve(trips); },
  };
  vm.createContext(sandbox);
  vm.runInContext(algoSrc, sandbox);
  vm.runInContext(bizWallClockSrc, sandbox);
  vm.runInContext(computeSrc, sandbox);
  return { sandbox, calls };
}

async function main() {
  // ---- One Geotab Trip fetch covers the WHOLE range, not one per day ----
  {
    const { sandbox, calls } = buildSandbox({
      trips: [
        { start: '2026-08-31T13:15:00.000Z', stop: '2026-08-31T13:15:00.000Z', stopAddress: 'DEPOT', device: { id: 'dev-b1' } },
        { start: '2026-08-31T13:15:00.000Z', stop: '2026-08-31T21:22:00.000Z', stopAddress: 'CLIENT', device: { id: 'dev-b1' } },
      ],
    });
    await sandbox._computeHoursForDateRange(['2026-08-31', '2026-09-01', '2026-09-02']);
    const tripFetches = calls.filter(function (c) { return c[0] === '_geotabCall' && c[1] === 'Get'; });
    check('exactly ONE Device fetch and ONE Trip fetch regardless of how many dates/teams', tripFetches.length, 2);
    check('device resolution runs once PER DAY (cheap RPC, not a Geotab trip fetch)', calls.filter(function (c) { return c[0] === '_resolveTeamDeviceMap'; }).length, 3);
  }

  // ---- Correct per-day, per-team bucketing from the single combined fetch ----
  {
    const trips = [
      // B1's device, Aug 31
      { start: '2026-08-31T13:15:00.000Z', stop: '2026-08-31T13:15:00.000Z', stopAddress: 'DEPOT', device: { id: 'dev-b1' } },
      { start: '2026-08-31T13:15:00.000Z', stop: '2026-08-31T21:22:00.000Z', stopAddress: 'CLIENT', device: { id: 'dev-b1' } },
      // B3's device, Sept 1 (different day, different team, same combined fetch)
      { start: '2026-09-01T14:00:00.000Z', stop: '2026-09-01T14:00:00.000Z', stopAddress: 'DEPOT', device: { id: 'dev-b3' } },
      { start: '2026-09-01T14:00:00.000Z', stop: '2026-09-01T20:00:00.000Z', stopAddress: 'CLIENT', device: { id: 'dev-b3' } },
    ];
    const { sandbox } = buildSandbox({ trips: trips });
    const result = await sandbox._computeHoursForDateRange(['2026-08-31', '2026-09-01', '2026-09-02']);
    check('B1 has hours on day 0 (Aug 31) only', result.B1.days, [8.116666666666667, 0, 0]);
    check('B3 has hours on day 1 (Sept 1) only', result.B3.days, [0, 6, 0]);
    check('B1 trueStart/trueEnd recorded for its own day', result.B1.starts[0].toISOString(), '2026-08-31T13:15:00.000Z');
    check('day 2 (Sept 2) has no data for either team -- no trips that day', [result.B1.days[2], result.B3.days[2]], [0, 0]);
  }

  // ---- Device swap mid-range (date-scoped override) is respected per day ----
  {
    const trips = [
      { start: '2026-08-31T13:15:00.000Z', stop: '2026-08-31T13:15:00.000Z', stopAddress: 'DEPOT', device: { id: 'dev-b1' } },
      { start: '2026-08-31T13:15:00.000Z', stop: '2026-08-31T21:22:00.000Z', stopAddress: 'CLIENT', device: { id: 'dev-b1' } },
      // Sept 1: B1 borrows a different vehicle ("dev-swap") for one day
      { start: '2026-09-01T13:15:00.000Z', stop: '2026-09-01T13:15:00.000Z', stopAddress: 'DEPOT', device: { id: 'dev-swap' } },
      { start: '2026-09-01T13:15:00.000Z', stop: '2026-09-01T19:15:00.000Z', stopAddress: 'CLIENT', device: { id: 'dev-swap' } },
    ];
    const { sandbox } = buildSandbox({
      teams: ['B1'],
      trips: trips,
      deviceByTeamDate: { 'B1_2026-09-01': { device: { id: 'dev-swap' }, isOverride: true } },
    });
    const result = await sandbox._computeHoursForDateRange(['2026-08-31', '2026-09-01']);
    check('B1 correctly picks up its OWN device on Aug 31', Math.round(result.B1.days[0] * 100) / 100, 8.12);
    check('B1 correctly picks up the SWAPPED device on Sept 1 (date-scoped override)', result.B1.days[1], 6);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
