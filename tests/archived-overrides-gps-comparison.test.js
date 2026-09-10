// Tom: "show me the 11 stale overrides in a table with... what the
// GPS-calculated hours would be without the override... Do NOT clear
// any yet - just show me the comparison."
//
// _readArchivedEmpHrsEntries() reads the _empHrs_archived_ keys PR #173
// preserved (instead of deleting) specifically so this review could
// happen. _computeGpsHoursForDay() is a faithful replication of the
// per-day GPS computation _loadWeekHoursInner() runs inline for the
// currently-loaded week (same real functions -- _findJobCrossrefStartEnd,
// _findTrueDepotDepartureTrip, _detectDayLunch -- same fallback order,
// same constants) but fetched independently for one arbitrary past
// team+date. This test extracts all of it verbatim from index.html and
// runs it against synthetic Geotab trip data, mocking only true I/O
// boundaries (isDepotAddress/isDepotPoint/matchStopToClientGeo,
// _geotabCallRetryOn429, _resolveTeamDevice, reverseGeocodeTrips) --
// same boundary-mocking convention as tests/lunch-detection-bounded.test.js.
//
// Run with: node tests/archived-overrides-gps-comparison.test.js

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

// Real algorithm chain: depot-departure detection, job-crossref
// start/end, lunch detection -- verbatim, same functions _loadWeekHoursInner
// itself calls.
const algoSrc = extract('function _findTrueDepotDepartureTrip(', '\nasync function loadWeekHours()');
// Real orchestration under test.
const archiveSrc = extract('function _readArchivedEmpHrsEntries() {', '\nasync function showArchivedOverridesComparison()');

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const sandbox = {
    console: console,
    window: { PentaLunchFlags: null },
    jobs: opts.jobs || [],
    dateKey: function (d) {
      var dt = (d instanceof Date) ? d : new Date(d);
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    },
    // Boundary mocks -- same convention as lunch-detection-bounded.test.js:
    // these are separately-covered dependencies, not the code under test.
    isDepotAddress: function (addr) { return addr === 'DEPOT'; },
    isDepotPoint: function () { return false; },
    matchStopToClientGeo: function (lat, lng, addr) { return addr === 'CLIENT' ? { id: 'c1', scheduled: true } : null; },
    _geotabCallRetryOn429: function (method, params) {
      calls.push(['_geotabCallRetryOn429', method, params]);
      if (params.typeName === 'Device') return Promise.resolve(opts.devices || [{ id: 'dev-1', name: 'B1 van' }]);
      if (params.typeName === 'Trip') return Promise.resolve(opts.trips || []);
      return Promise.resolve([]);
    },
    _resolveTeamDevice: function (devices, team, date) {
      calls.push(['_resolveTeamDevice', team]);
      return Promise.resolve(opts.resolvedDevice !== undefined ? opts.resolvedDevice : { device: devices[0], source: 'assignment' });
    },
    reverseGeocodeTrips: function (trips) { return Promise.resolve(trips); },
    // getUnifiedRoster for _readArchivedEmpHrsEntries
    getUnifiedRoster: function () { return opts.roster || []; },
  };
  vm.createContext(sandbox);
  vm.runInContext(algoSrc, sandbox);
  vm.runInContext(archiveSrc, sandbox);
  return { sandbox, calls };
}

function fakeLocalStorage(initial) {
  var store = Object.assign({}, initial);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: function (i) { return Object.keys(store)[i] || null; },
  };
}

async function main() {
  // ---- _readArchivedEmpHrsEntries: parses the archived key shape,
  // resolves employee name, prefers the record's own `team` field. ----
  {
    const { sandbox } = buildSandbox({ roster: [{ id: 'e_123', name: 'Eunice Moreno' }] });
    sandbox.localStorage = fakeLocalStorage({
      '_empHrs_archived_e_123_2026-08-03': JSON.stringify({ start: '09:00', end: '17:00', lunch: 30, hours: 7.5, team: 'B1' }),
      'weekHours_cache': '{}',
    });
    const rows = sandbox._readArchivedEmpHrsEntries();
    check('exactly one archived entry is found (unrelated keys ignored)', rows.length, 1);
    check('employee name is resolved via getUnifiedRoster', rows[0].employee, 'Eunice Moreno');
    check('date is parsed correctly', rows[0].date, '2026-08-03');
    check('team comes from the record itself', rows[0].team, 'B1');
    check('override values are carried through', rows[0].override, { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 });
  }

  // ---- unresolvable employee id doesn't crash, shows a placeholder ----
  {
    const { sandbox } = buildSandbox({ roster: [] });
    sandbox.localStorage = fakeLocalStorage({ '_empHrs_archived_e_999_2026-08-03': JSON.stringify({ start: '09:00' }) });
    const rows = sandbox._readArchivedEmpHrsEntries();
    check('unknown employee id gets a clear placeholder, not a crash', /unknown employee/.test(rows[0].employee), true);
  }

  // ---- _computeGpsHoursForDay: no device assigned that day ----
  {
    const { sandbox } = buildSandbox({ resolvedDevice: { device: null, source: 'assignment-none' } });
    const r = await sandbox._computeGpsHoursForDay('B1', '2026-08-03');
    check('no device assigned -> unavailable with a clear reason', r.available, false);
    check('the reason names the team and date', /B1/.test(r.reason) && /2026-08-03/.test(r.reason), true);
  }

  // ---- no trips recorded that day ----
  {
    const { sandbox } = buildSandbox({ trips: [] });
    const r = await sandbox._computeGpsHoursForDay('B1', '2026-08-03');
    check('no trips -> unavailable', r.available, false);
  }

  // ---- a normal day: depot -> client -> depot, no lunch stop ----
  {
    const trips = [
      { start: '2026-08-03T13:00:00.000Z', stop: '2026-08-03T13:15:00.000Z', stopAddress: 'DEPOT', startAddress: 'DEPOT' },
      { start: '2026-08-03T13:15:00.000Z', stop: '2026-08-03T20:00:00.000Z', stopAddress: 'CLIENT' },
      { start: '2026-08-03T20:00:00.000Z', stop: '2026-08-03T21:22:00.000Z', stopAddress: 'DEPOT' },
    ];
    const { sandbox } = buildSandbox({ trips: trips });
    const r = await sandbox._computeGpsHoursForDay('B1', '2026-08-03');
    check('GPS hours are computed for a normal day', r.available, true);
    // true start = the depot departure at 13:15Z (prev trip WAS a depot
    // stop), true end = the last depot arrival at 21:22Z -- 8h07m raw,
    // no lunch candidate (only stop besides depot is the client stop).
    check('computed hours match the raw depot-to-depot span (no lunch detected)', Math.round(r.hours * 100) / 100, 8.12);
    check('lunch minutes are 0 when nothing qualifies', r.lunchMin, 0);
  }

  // ---- a day with a genuine unmatched short stop counted as lunch ----
  {
    const trips = [
      { start: '2026-08-03T13:00:00.000Z', stop: '2026-08-03T13:15:00.000Z', stopAddress: 'DEPOT', startAddress: 'DEPOT' },
      { start: '2026-08-03T13:15:00.000Z', stop: '2026-08-03T17:00:00.000Z', stopAddress: 'CLIENT' },
      { start: '2026-08-03T17:30:00.000Z', stop: '2026-08-03T18:00:00.000Z', stopAddress: 'Lunch spot' }, // 30 min unmatched short stop
      { start: '2026-08-03T18:30:00.000Z', stop: '2026-08-03T21:22:00.000Z', stopAddress: 'DEPOT' },
    ];
    const { sandbox } = buildSandbox({ trips: trips });
    const r = await sandbox._computeGpsHoursForDay('B1', '2026-08-03');
    check('a genuine unmatched short stop is detected as lunch', r.lunchMin, 30);
    // raw span 13:15Z-21:22Z = 8h07m, minus 30min lunch = 7.617h
    check('lunch minutes are deducted from the final hours', Math.round(r.hours * 100) / 100, 7.62);
  }

  // ---- a span that fails the sanity check (>15h) is reported, not
  // silently accepted as real ----
  {
    const trips = [
      { start: '2026-08-03T04:00:00.000Z', stop: '2026-08-03T04:15:00.000Z', stopAddress: 'DEPOT', startAddress: 'DEPOT' },
      { start: '2026-08-03T04:15:00.000Z', stop: '2026-08-03T23:59:00.000Z', stopAddress: 'CLIENT' },
    ];
    const { sandbox } = buildSandbox({ trips: trips });
    const r = await sandbox._computeGpsHoursForDay('B1', '2026-08-03');
    check('an implausible span fails the sanity check instead of being reported as real hours', r.available, false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
