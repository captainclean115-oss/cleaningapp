// Team Day Report speed (team-day-report-v3 branch): proves the new
// batched range fetch (_tdrFetchRangeData + _tdrSliceTeamDayFromRange,
// one Device/Trip/GetAddresses call per REPORT RUN) produces results
// IDENTICAL to the original per-team-day fetch (_fetchTeamDayGpsDetail,
// one Device/Trip/GetAddresses call per TEAM-DAY -- completely
// unmodified by this branch) for the same recorded Geotab fixture.
//
// Extracts both the old and new code paths verbatim from index.html,
// plus every pure function they both depend on
// (_findJobCrossrefStartEnd/_findTrueDepotDepartureTrip/_detectDayLunch,
// _computeGpsHoursFromTrips, _buildGpsStopList, _resolveTeamDevice/
// _resolveTeamDeviceMap, reverseGeocodeTrips, _geotabCallRetryOn429,
// _bizWallClockToUtc) -- only the true I/O boundary (_geotabCall itself,
// and the Supabase RPC _resolveTeamDevice calls) is mocked, driven by
// one shared fixture so both paths see the exact same underlying data.
//
// Covers the required edge cases: a trip crossing midnight, a team
// with no device assigned, a fully-exhausted 429 (both the batched
// range fetch and the per-day fallback path), and a failed address
// lookup (reverseGeocodeTrips's own existing try/catch already
// swallows this -- confirmed it doesn't break either path).
//
// Run with: node tests/team-day-report-speed.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

// Same algorithm-chain marker the existing hours-report-range-computation
// test already extracts (_findJobCrossrefStartEnd, _findTrueDepotDepartureTrip,
// _detectDayLunch, and the other small pure helpers _computeGpsHoursFromTrips
// itself depends on).
const algoSrc = extract('function _findTrueDepotDepartureTrip(', '\nasync function loadWeekHours()', 'depot/lunch algorithm chain');
const bizWallClockSrc = extract('function _bizWallClockToUtc(', '\n\n// Returns { fromDate, toDate,', '_bizWallClockToUtc');
const gpsHoursAndFetchSrc = extract('function _computeGpsHoursFromTrips(trips, team, dateStr) {', '\n\nasync function showArchivedOverridesComparison() {', '_computeGpsHoursFromTrips + _fetchTeamDayGpsDetail (OLD path, untouched)');
const retrySrc = extract('async function _geotabCallRetryOn429(method, params) {', '\n\nasync function showEmpStops', '_geotabCallRetryOn429');
const resolveDeviceSrc = extract('async function _resolveTeamDevice(devices, team, dateObj) {', '\n\nasync function renderGeotabIntegrationStatus() {', '_resolveTeamDevice + _resolveTeamDeviceMap');
const geocodeSrc = extract('async function reverseGeocodeTrips(trips) {', '\n\n// "Last 24 hours" (default)', 'reverseGeocodeTrips');
const stopListSrc = extract('function _buildGpsStopList(sortedTrips, team, dateObj, trimToDay) {', '\n\n// Shared per-stop row renderer', '_buildGpsStopList');
const tdrSource = extract('var TDR_MAX_RANGE_DAYS = 31;', '\nfunction openTeamDayReport() {', 'Team Day Report v3 module (NEW batched path)');

const fnSource = [algoSrc, bizWallClockSrc, gpsHoursAndFetchSrc, retrySrc, resolveDeviceSrc, geocodeSrc, stopListSrc, tdrSource].join('\n');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

const TZ = 'America/New_York';

function buildSandbox(opts) {
  opts = opts || {};
  const calls = []; // [kind, ...] -- used to count real Geotab/RPC round trips
  const devices = opts.devices || [{ id: 'dev-b1' }, { id: 'dev-s1' }];
  const trips = opts.trips || [];
  // deviceAssignments: 'team|dateStr' -> deviceId | null (null = no device that day)
  const deviceAssignments = opts.deviceAssignments || {};
  let tripGetCallCount = 0;

  const sandbox = {
    console, setTimeout,
    window: {
      PentaLunchFlags: null,
      supabaseClient: {
        rpc: function (name, params) {
          calls.push(['rpc', name, params.p_team_code, params.p_on_date]);
          var key = params.p_team_code + '|' + params.p_on_date;
          var deviceId = Object.prototype.hasOwnProperty.call(deviceAssignments, key) ? deviceAssignments[key] : null;
          if (deviceId === null) return Promise.resolve({ data: [{ device_id: null, is_override: false }], error: null });
          return Promise.resolve({ data: [{ device_id: deviceId, is_override: false }], error: null });
        },
      },
      PentaTenant: { current: function () { return 'biz-fixture'; } },
    },
    jobs: [],
    isDepotAddress: function (addr) { return addr === 'DEPOT'; },
    isDepotPoint: function () { return false; },
    getDepotForTeam: function () { return null; },
    matchStopToClientGeo: function () { return null; },
    matchStopToClientObj: function () { return null; },
    dateKey: function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
    _pentaBusinessTimezone: function () { return TZ; },
    _pentaTeamNames: function () { return opts.teams || ['B1', 'S1']; },

    _geotabCall: function (method, params) {
      if (method === 'Get' && params.typeName === 'Device') {
        calls.push(['Device']);
        return Promise.resolve(devices);
      }
      if (method === 'Get' && params.typeName === 'Trip') {
        tripGetCallCount++;
        calls.push(['Trip', params.search.deviceSearch ? 'per-device' : 'whole-range']);
        if (opts.rateLimitOnTripCall && tripGetCallCount === opts.rateLimitOnTripCall) {
          var err = new Error('rate limited'); err.isRateLimit = true; throw err;
        }
        if (params.search.deviceSearch) {
          var did = params.search.deviceSearch.id;
          return Promise.resolve(trips.filter(function (t) { return t.device && t.device.id === did; }));
        }
        return Promise.resolve(trips.slice());
      }
      if (method === 'GetAddresses') {
        calls.push(['GetAddresses', params.coordinates.length]);
        if (opts.addressLookupFails) { var e2 = new Error('geocode service down'); throw e2; }
        return Promise.resolve(params.coordinates.map(function () { return { street: 'Fixture St', city: 'Fixture City' }; }));
      }
      return Promise.resolve([]);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, calls };
}

function pt(x, y) { return { x: x, y: y }; }

async function main() {
  // ── Basic equivalence: ordinary trips, two teams, two days ──
  {
    const trips = [
      { device: { id: 'dev-b1' }, start: '2026-09-10T13:00:00.000Z', stop: '2026-09-10T13:20:00.000Z', startPoint: pt(-71.1, 42.3), stopPoint: pt(-71.2, 42.4) },
      { device: { id: 'dev-b1' }, start: '2026-09-10T20:00:00.000Z', stop: '2026-09-10T20:05:00.000Z', startPoint: pt(-71.2, 42.4), stopPoint: pt(-71.1, 42.3) },
      { device: { id: 'dev-s1' }, start: '2026-09-11T14:00:00.000Z', stop: '2026-09-11T14:30:00.000Z', startPoint: pt(-71.3, 42.5), stopPoint: pt(-71.4, 42.6) },
    ];
    const deviceAssignments = {
      'B1|2026-09-10': 'dev-b1', 'B1|2026-09-11': 'dev-b1',
      'S1|2026-09-10': 'dev-s1', 'S1|2026-09-11': 'dev-s1',
    };
    const { sandbox: oldSb } = buildSandbox({ trips, deviceAssignments });
    const { sandbox: newSb } = buildSandbox({ trips, deviceAssignments });

    const oldB1Day1 = await oldSb._fetchTeamDayGpsDetail('B1', '2026-09-10');
    const oldS1Day2 = await oldSb._fetchTeamDayGpsDetail('S1', '2026-09-11');

    const rangeData = await newSb._tdrFetchRangeData(['2026-09-10', '2026-09-11'], ['B1', 'S1'], TZ);
    checkTrue('range fetch succeeded (not null/truncated)', !!rangeData);
    const newB1Day1 = newSb._tdrSliceTeamDayFromRange(rangeData, 'B1', '2026-09-10', TZ);
    const newS1Day2 = newSb._tdrSliceTeamDayFromRange(rangeData, 'S1', '2026-09-11', TZ);

    check('B1/day1: gps result identical old vs new', JSON.stringify(oldB1Day1.gps), JSON.stringify(newB1Day1.gps));
    check('B1/day1: stopList identical old vs new', JSON.stringify(oldB1Day1.stopList), JSON.stringify(newB1Day1.stopList));
    check('S1/day2: gps result identical old vs new', JSON.stringify(oldS1Day2.gps), JSON.stringify(newS1Day2.gps));
    check('S1/day2: stopList identical old vs new', JSON.stringify(oldS1Day2.stopList), JSON.stringify(newS1Day2.stopList));
  }

  // ── A trip crossing midnight: attributed to its start day, identically in both paths ──
  {
    // 2026-09-10 23:50 EDT (UTC-4) = 2026-09-11 03:50Z; stop 00:10 EDT next day = 2026-09-11 04:10Z.
    const crossing = { device: { id: 'dev-b1' }, start: '2026-09-11T03:50:00.000Z', stop: '2026-09-11T04:10:00.000Z', startPoint: pt(-71.1, 42.3), stopPoint: pt(-71.1, 42.3) };
    const trips = [crossing];
    const deviceAssignments = { 'B1|2026-09-10': 'dev-b1', 'B1|2026-09-11': 'dev-b1' };

    const { sandbox: oldSb } = buildSandbox({ trips, deviceAssignments });
    const oldDay1 = await oldSb._fetchTeamDayGpsDetail('B1', '2026-09-10');
    const oldDay2 = await oldSb._fetchTeamDayGpsDetail('B1', '2026-09-11');

    const { sandbox: newSb } = buildSandbox({ trips, deviceAssignments });
    const rangeData = await newSb._tdrFetchRangeData(['2026-09-10', '2026-09-11'], ['B1'], TZ);
    const newDay1 = newSb._tdrSliceTeamDayFromRange(rangeData, 'B1', '2026-09-10', TZ);
    const newDay2 = newSb._tdrSliceTeamDayFromRange(rangeData, 'B1', '2026-09-11', TZ);

    check('midnight-crossing trip: day1 trip count identical old vs new', oldDay1.trips.length, newDay1.trips.length);
    check('midnight-crossing trip: day2 trip count identical old vs new', oldDay2.trips.length, newDay2.trips.length);
    checkTrue('the crossing trip is attributed to its START day (day1), not day2, in BOTH paths', oldDay1.trips.length === 1 && oldDay2.trips.length === 0 && newDay1.trips.length === 1 && newDay2.trips.length === 0);
    check('day1 gps result identical old vs new for the crossing trip', JSON.stringify(oldDay1.gps), JSON.stringify(newDay1.gps));
  }

  // ── A team with no device assigned: identical "unavailable" shape in both paths ──
  {
    const trips = [];
    const deviceAssignments = { 'B1|2026-09-10': null };
    const { sandbox: oldSb } = buildSandbox({ trips, deviceAssignments });
    const oldResult = await oldSb._fetchTeamDayGpsDetail('B1', '2026-09-10');

    const { sandbox: newSb } = buildSandbox({ trips, deviceAssignments });
    const rangeData = await newSb._tdrFetchRangeData(['2026-09-10'], ['B1'], TZ);
    const newResult = newSb._tdrSliceTeamDayFromRange(rangeData, 'B1', '2026-09-10', TZ);

    check('no-device: device is null in both paths', [oldResult.device, newResult.device], [null, null]);
    check('no-device: gps.available is false in both paths', [oldResult.gps.available, newResult.gps.available], [false, false]);
    checkTrue('no-device: resolved.source is "assignment-none" in both paths', oldResult.resolved.source === 'assignment-none' && newResult.resolved.source === 'assignment-none');
  }

  // ── A fully-exhausted 429 on the batched range fetch falls back cleanly (no throw, null result) ──
  {
    const trips = [{ device: { id: 'dev-b1' }, start: '2026-09-10T13:00:00.000Z', stop: '2026-09-10T13:20:00.000Z', startPoint: pt(-71.1, 42.3), stopPoint: pt(-71.1, 42.3) }];
    const deviceAssignments = { 'B1|2026-09-10': 'dev-b1' };
    // _geotabCallRetryOn429 tries once, waits 1.5s on isRateLimit, tries once more --
    // rateLimitOnTripCall fires on BOTH of those Trip-Get attempts (calls 1 and 2 overall,
    // since Device uses a separate call type), i.e. fully exhausted.
    const { sandbox } = buildSandbox({ trips, deviceAssignments, rateLimitOnTripCall: 1 });
    // Make the 2nd internal retry attempt also fail, by re-arming after the first throw.
    var originalGeotabCall = sandbox._geotabCall;
    var tripAttempts = 0;
    sandbox._geotabCall = function (method, params) {
      if (method === 'Get' && params.typeName === 'Trip') {
        tripAttempts++;
        var err = new Error('rate limited'); err.isRateLimit = true; throw err;
      }
      return originalGeotabCall(method, params);
    };
    const rangeData = await sandbox._tdrFetchRangeData(['2026-09-10'], ['B1'], TZ);
    check('range fetch returns null (not a throw) when the Trip fetch is fully rate-limited', rangeData, null);
    checkTrue('both of _geotabCallRetryOn429\'s own attempts were actually exhausted', tripAttempts === 2);
  }

  // ── A fully-exhausted 429 on the per-day FALLBACK path drops concurrency to 1 for the rest of the run ──
  {
    const trips = [{ device: { id: 'dev-b1' }, start: '2026-09-10T13:00:00.000Z', stop: '2026-09-10T13:20:00.000Z', startPoint: pt(-71.1, 42.3), stopPoint: pt(-71.1, 42.3) }];
    const deviceAssignments = { 'B1|2026-09-10': 'dev-b1' };
    const { sandbox } = buildSandbox({ trips, deviceAssignments });
    sandbox._tdrRangeData = null; // force the fallback path
    sandbox._tdrRangeFallbackConcurrency = 3;
    var tripAttempts = 0;
    var originalGeotabCall = sandbox._geotabCall;
    sandbox._geotabCall = function (method, params) {
      if (method === 'Get' && params.typeName === 'Trip') {
        tripAttempts++;
        var err = new Error('rate limited'); err.isRateLimit = true; throw err;
      }
      return originalGeotabCall(method, params);
    };
    const outcome = await sandbox._tdrFetchTeamDay('B1', '2026-09-10');
    check('fallback fetch reports failure, not a thrown error out of _tdrFetchTeamDay', outcome.ok, false);
    check('fallback pool concurrency dropped to 1 after the fully-exhausted 429', sandbox._tdrRangeFallbackConcurrency, 1);
  }

  // ── A failed address lookup degrades gracefully (reverseGeocodeTrips's own existing catch), identically in both paths ──
  {
    const trips = [{ device: { id: 'dev-b1' }, start: '2026-09-10T13:00:00.000Z', stop: '2026-09-10T13:20:00.000Z', startPoint: pt(-71.1, 42.3), stopPoint: pt(-71.1, 42.3) }];
    const deviceAssignments = { 'B1|2026-09-10': 'dev-b1' };
    const { sandbox: oldSb } = buildSandbox({ trips, deviceAssignments, addressLookupFails: true });
    const oldResult = await oldSb._fetchTeamDayGpsDetail('B1', '2026-09-10');

    const { sandbox: newSb } = buildSandbox({ trips, deviceAssignments, addressLookupFails: true });
    const rangeData = await newSb._tdrFetchRangeData(['2026-09-10'], ['B1'], TZ);
    checkTrue('a failed address lookup does not fail the whole batched range fetch', !!rangeData);
    const newResult = newSb._tdrSliceTeamDayFromRange(rangeData, 'B1', '2026-09-10', TZ);

    check('gps result identical old vs new despite the failed address lookup', JSON.stringify(oldResult.gps), JSON.stringify(newResult.gps));
    checkTrue('neither path crashed -- reverseGeocodeTrips\'s own try/catch absorbed the failure in both', !!oldResult && !!newResult);
  }

  // ── Call-count reduction (the actual speed win) ──
  {
    const teams = ['B1', 'S1'];
    const dates = ['2026-09-10', '2026-09-11'];
    const trips = [
      { device: { id: 'dev-b1' }, start: '2026-09-10T13:00:00.000Z', stop: '2026-09-10T13:20:00.000Z', startPoint: pt(-71.1, 42.3), stopPoint: pt(-71.1, 42.3) },
      { device: { id: 'dev-s1' }, start: '2026-09-11T14:00:00.000Z', stop: '2026-09-11T14:30:00.000Z', startPoint: pt(-71.3, 42.5), stopPoint: pt(-71.4, 42.6) },
    ];
    const deviceAssignments = {
      'B1|2026-09-10': 'dev-b1', 'B1|2026-09-11': 'dev-b1',
      'S1|2026-09-10': 'dev-s1', 'S1|2026-09-11': 'dev-s1',
    };

    // OLD: one _fetchTeamDayGpsDetail call per team-day (4 team-days) -- each
    // issues its own Device + Trip + GetAddresses call.
    const { sandbox: oldSb, calls: oldCalls } = buildSandbox({ trips, deviceAssignments });
    for (const team of teams) for (const d of dates) { await oldSb._fetchTeamDayGpsDetail(team, d); }
    const oldDeviceCalls = oldCalls.filter((c) => c[0] === 'Device').length;
    const oldTripCalls = oldCalls.filter((c) => c[0] === 'Trip').length;
    const oldGeoCalls = oldCalls.filter((c) => c[0] === 'GetAddresses').length;

    // NEW: one batched range fetch for the whole run, regardless of team/day count.
    const { sandbox: newSb, calls: newCalls } = buildSandbox({ trips, deviceAssignments });
    await newSb._tdrFetchRangeData(dates, teams, TZ);
    const newDeviceCalls = newCalls.filter((c) => c[0] === 'Device').length;
    const newTripCalls = newCalls.filter((c) => c[0] === 'Trip').length;
    const newGeoCalls = newCalls.filter((c) => c[0] === 'GetAddresses').length;

    check('OLD path: one Device Get per team-day (2 teams x 2 days = 4)', oldDeviceCalls, 4);
    check('OLD path: one Trip Get per team-day (4)', oldTripCalls, 4);
    // Only 2 of the 4 team-days have any trip at all in this fixture (B1/day1,
    // S1/day2) -- reverseGeocodeTrips itself skips the GetAddresses call
    // entirely when there are no points (unmodified early-return), same in
    // both paths, so 2 is correct here, not 4.
    check('OLD path: one GetAddresses per team-day that actually has trips (2 of 4)', oldGeoCalls, 2);
    check('NEW path: exactly one Device Get for the whole run', newDeviceCalls, 1);
    check('NEW path: exactly one Trip Get for the whole run', newTripCalls, 1);
    check('NEW path: exactly one GetAddresses for the whole run', newGeoCalls, 1);
    console.log('  -- for 2 teams x 2 days: OLD = ' + (oldDeviceCalls + oldTripCalls + oldGeoCalls) + ' Geotab calls, NEW = ' + (newDeviceCalls + newTripCalls + newGeoCalls) + ' Geotab calls');
    // Extrapolated (same ratio, Device/Trip/GetAddresses -> 1 call each regardless of scale):
    // 8 teams x 7 days = 56 team-days -> OLD 56*3 = 168 Geotab calls, NEW = 3 Geotab calls total.
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
