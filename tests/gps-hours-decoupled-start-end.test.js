// PR #185 -- _findJobCrossrefStartEnd used to gate BOTH start and end
// confirmation behind a single `matched` flag: if the day's end couldn't
// be job-confirmed, a perfectly good, confirmed START got thrown away
// too, and the caller fell all the way back to the pure depot heuristic
// for BOTH sides. Concrete case (Emilia, M2, real Sept 2 data): a real
// 8:32am-2:17pm workday had its END go unconfirmed only because the
// trip immediately before the final depot arrival wasn't one of that
// day's sparse job records (2 scheduled jobs against 6 real trips) --
// so the correctly-confirmed 8:32am start was discarded and the
// fallback picked 2:25pm as "the start" instead, producing a 0.3h
// fragment instead of ~5.5h.
//
// This test proves, against the REAL extracted _findJobCrossrefStartEnd
// (not a reimplementation):
//   1. startMatched/endMatched are now independent -- one can be true
//      while the other is false.
//   2. A stop that's client-adjacent, non-depot, and has a real dwell
//      time confirms work even when it doesn't match one of TODAY'S
//      scheduled jobs specifically (the loosened check).
//   3. A too-short dwell (GPS blip) does NOT confirm work -- guards
//      against over-loosening.
//   4. A depot-address stop itself never counts as "looks like work".
//   5. End-to-end faithful replication: the REAL Sept 2 Geotab trip
//      data for Emilia's day (device b10E, real addresses/coordinates,
//      real scheduled jobs) run through the REAL _computeGpsHoursForDay
//      now produces the correct ~8:32am-2:17pm span instead of the
//      2:25pm-3:41pm fragment.
//
// Run with: node tests/gps-hours-decoupled-start-end.test.js

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

const distSrc = extract('function distKm(', '\n\n// v11.0.4 (Issue A)');
const matchGeoSrc = extract('function matchStopToClientGeo(', '\n\n// Get selected date for GPS queries');
const crossrefSrc = extract('var MIN_WORK_STOP_DWELL_MIN = 5;', '\n\n// PR #116 — REMOVED.');
const depotHeuristicSrc = extract('function _findTrueDepotDepartureTrip(', '\n\n// PR #117');
const gpsHoursForDaySrc = extract('async function _computeGpsHoursForDay(team, dateStr) {', '\n\n// PR #120');

function buildSandbox(opts) {
  opts = opts || {};
  const clients = opts.clients || [];
  const pentaClients = { forEachClient: function (fn) { clients.forEach(fn); } };
  const sandbox = {
    console,
    window: { PentaClients: pentaClients },
    PentaClients: pentaClients,
    GPS_CLIENT_MATCH_HIGH_FT: 200,
    GPS_CLIENT_MATCH_LOW_FT: 400,
    matchStopToClientObj: function () { return null; }, // no-lat/lng fallback -- unused, every test stop has stopPoint
  };
  vm.createContext(sandbox);
  vm.runInContext(distSrc, sandbox);
  vm.runInContext(matchGeoSrc, sandbox);
  vm.runInContext(crossrefSrc, sandbox);
  vm.runInContext(depotHeuristicSrc, sandbox);
  return sandbox;
}

function trip(startIso, stopIso, stopAddr, lat, lng) {
  return { start: startIso, stop: stopIso, stopAddress: stopAddr, stopPoint: { x: lng, y: lat } };
}

function isDepotStopFactory(depotLat, depotLng) {
  return function (t) {
    var sa = t.stopAddress || '';
    if (/depot/i.test(sa)) return true;
    if (t.stopPoint) {
      var d = 0;
      // reuse distFeet indirectly via a simple threshold check in the test
      return false; // address-string flag is enough for these synthetic cases
    }
    return false;
  };
}

function main() {
  // ==== Unit-level: decoupling + loosened end-confirmation ====
  {
    const sandbox = buildSandbox({
      clients: [
        { id: 'c-scheduled', status: 'active', lat: 42.0, lng: -71.0, fn: 'Sched', ln: 'Client' },
        { id: 'c-unscheduled', status: 'active', lat: 42.01, lng: -71.0, fn: 'Unsched', ln: 'Client' },
      ],
    });
    const isDepotStop = function (t) { return /depot/i.test(t.stopAddress || ''); };

    // trip0: job-confirmed start (matches c-scheduled, which IS in todayTeamJobs)
    // trip1: NOT job-confirmed but client-adjacent + reasonable dwell (c-unscheduled, NOT in todayTeamJobs) -- precedes the depot arrival
    // trip2: depot arrival (the day's end)
    const trips = [
      trip('2026-01-01T12:00:00Z', '2026-01-01T12:10:00Z', 'Scheduled client stop', 42.0, -71.0),
      trip('2026-01-01T13:00:00Z', '2026-01-01T13:30:00Z', 'Unscheduled but real client stop', 42.01, -71.0),
      trip('2026-01-01T14:00:00Z', '2026-01-01T14:05:00Z', 'The Depot', 42.5, -71.5),
    ];
    const todayTeamJobs = [{ clientId: 'c-scheduled' }]; // only the FIRST stop's client is a scheduled job today

    const result = sandbox._findJobCrossrefStartEnd(trips, isDepotStop, todayTeamJobs, 'M2');
    check('start is job-confirmed (trip0)', result.startMatched, true);
    check('end is confirmed via the LOOSENED check (trip1 is client-adjacent + real dwell, even though not scheduled today)', result.endMatched, true);
    check('trueStartTrip is trip0', result.trueStartTrip.start, trips[0].start);
    check('trueEndTrip is the depot arrival (trip2)', result.trueEndTrip.start, trips[2].start);
  }

  // ==== Decoupling: a confirmed start survives even when end truly can't be confirmed ====
  {
    const sandbox = buildSandbox({ clients: [{ id: 'c-scheduled', status: 'active', lat: 42.0, lng: -71.0 }] });
    const isDepotStop = function (t) { return /depot/i.test(t.stopAddress || ''); };
    const trips = [
      trip('2026-01-01T12:00:00Z', '2026-01-01T12:10:00Z', 'Scheduled client stop', 42.0, -71.0),
      // A GPS blip (1-minute dwell before the next trip) right before the depot arrival -- not a real work stop.
      trip('2026-01-01T13:00:00Z', '2026-01-01T13:00:30Z', 'Random blip, no client nearby', 45.0, -75.0),
      trip('2026-01-01T13:01:30Z', '2026-01-01T13:05:00Z', 'The Depot', 42.5, -71.5),
    ];
    const todayTeamJobs = [{ clientId: 'c-scheduled' }];
    const result = sandbox._findJobCrossrefStartEnd(trips, isDepotStop, todayTeamJobs, 'M2');
    check('start still confirmed even though end is not', result.startMatched, true);
    check('end NOT confirmed -- the only depot-preceding stop is an unmatched blip', result.endMatched, false);
    check('old-style `matched` (both) correctly reflects the partial result', result.matched, false);
  }

  // ==== Guard: a too-short dwell near a real client does NOT count as work ====
  {
    const sandbox = buildSandbox({ clients: [{ id: 'c1', status: 'active', lat: 42.0, lng: -71.0 }] });
    const isDepotStop = function (t) { return /depot/i.test(t.stopAddress || ''); };
    const trips = [
      // Drove past a real client's address but only paused 2 minutes (below MIN_WORK_STOP_DWELL_MIN) before immediately heading to the depot.
      trip('2026-01-01T12:00:00Z', '2026-01-01T12:02:00Z', 'Near a real client but a blip', 42.0, -71.0),
      trip('2026-01-01T12:04:00Z', '2026-01-01T12:08:00Z', 'The Depot', 42.5, -71.5),
    ];
    const result = sandbox._findJobCrossrefStartEnd(trips, isDepotStop, [], 'M2');
    check('a real-client-adjacent stop with too-short a dwell does not confirm work', result.matched, false);
    check('startMatched false too -- no stop anywhere qualifies', result.startMatched, false);
  }

  // ==== Guard: the depot stop itself never counts as "looks like work" ====
  {
    const sandbox = buildSandbox({ clients: [{ id: 'c1', status: 'active', lat: 42.5, lng: -71.5 }] });
    const isDepotStop = function (t) { return /depot/i.test(t.stopAddress || ''); };
    // The depot happens to be geocoded near a "client" record too (edge case) -- must still be excluded as a work stop.
    const trips = [
      trip('2026-01-01T12:00:00Z', '2026-01-01T12:30:00Z', 'The Depot', 42.5, -71.5),
      trip('2026-01-01T13:00:00Z', '2026-01-01T13:05:00Z', 'The Depot', 42.5, -71.5),
    ];
    const result = sandbox._findJobCrossrefStartEnd(trips, isDepotStop, [], 'M2');
    check('depot stops are never confirmed as work regardless of client proximity', result.matched, false);
  }

  // ==== End-to-end faithful replication: Emilia's real Sept 2 data ====
  {
    const sandbox = buildSandbox({
      clients: [
        // Real Manna client geocode for the two scheduled M2 jobs that day.
        { id: '1844137', status: 'active', lat: 42.3743812, lng: -71.5173232, fn: 'Brian', ln: 'Stevens' },
        { id: '1844136', status: 'active', lat: 42.3511743, lng: -71.5638428, fn: 'Brian', ln: 'Stevens' },
      ],
    });
    vm.runInContext(gpsHoursForDaySrc, sandbox);

    const depotLat = 42.350958, depotLng = -71.4948242;
    const isDepotStop = function (t) {
      var sa = t.stopAddress || '';
      var pt = t.stopPoint;
      if (pt) {
        var dist = sandbox.distFeet(pt.y, pt.x, depotLat, depotLng);
        if (dist <= 400) return true;
      }
      return /Boston Post Rd/i.test(sa);
    };

    // The REAL 6 trips for device b10E on 2026-09-02, gathered live from Geotab.
    const realTrips = [
      trip('2026-09-02T12:32:52.000Z', '2026-09-02T12:43:23.000Z', '73 Dean Rd, Marlborough', 42.374324798583984, -71.5179214477539),
      trip('2026-09-02T14:25:18.000Z', '2026-09-02T14:39:38.000Z', '249 Pleasant St, Marlborough', 42.35108947753906, -71.56372833251953),
      trip('2026-09-02T16:15:01.691Z', '2026-09-02T16:34:11.000Z', '46A Hildreth St, Marlborough', 42.34782028198242, -71.5406723022461),
      trip('2026-09-02T18:06:24.792Z', '2026-09-02T18:17:16.000Z', '910 Boston Post Rd E, Marlborough', 42.350830078125, -71.49271392822266),
      trip('2026-09-02T18:25:27.959Z', '2026-09-02T18:39:54.000Z', '460 Lincoln St, Marlborough', 42.345829010009766, -71.55989837646484),
      trip('2026-09-02T19:37:41.759Z', '2026-09-02T19:41:06.000Z', '506 Lincoln St, Marlborough', 42.34461212158203, -71.56202697753906),
    ];

    sandbox.jobs = [
      { date: '2026-09-02', team: 'M2', clientId: '1844137', cancelled: false },
      { date: '2026-09-02', team: 'M2', clientId: '1844136', cancelled: false },
    ];
    sandbox._geotabCallRetryOn429 = function (method, params) {
      if (params.typeName === 'Device') return Promise.resolve([{ id: 'b10E', name: 'M1' }]);
      if (params.typeName === 'Trip') return Promise.resolve(realTrips);
      return Promise.resolve([]);
    };
    sandbox._resolveTeamDevice = function () { return Promise.resolve({ device: { id: 'b10E', name: 'M1' }, source: 'assignment', isOverride: true }); };
    sandbox.reverseGeocodeTrips = function () { return Promise.resolve(); };
    sandbox._pentaBusinessTimezone = function () { return 'America/New_York'; };
    sandbox._bizWallClockToUtc = function (y, m, d, hh, mm, ss) { return new Date(Date.UTC(y, m - 1, d, hh + 4, mm, ss)); }; // EDT = UTC-4
    sandbox._detectDayLunch = function () { return null; }; // isolate the start/end fix; lunch detection has its own tests
    sandbox.getDepotForTeam = function () { return { lat: depotLat, lng: depotLng }; };
    sandbox.isDepotAddress = function (addr) { return /Boston Post Rd/i.test(addr || ''); };
    sandbox.isDepotPoint = function (pt) { return pt ? sandbox.distFeet(pt.y, pt.x, depotLat, depotLng) <= 400 : false; };

    return sandbox._computeGpsHoursForDay('M2', '2026-09-02').then(function (result) {
      check('day is available (not rejected by the sanity check)', result.available, true);
      check('start is the REAL 8:32am office departure, not the 2:25pm fragment', result.start.toISOString(), '2026-09-02T12:32:52.000Z');
      check('end is the REAL 2:17pm office return', result.end.toISOString(), '2026-09-02T18:17:16.000Z');
      const rawHrs = (new Date(result.end) - new Date(result.start)) / 3600000;
      check('raw span is ~5.74h (matches MyGeotab\'s "~6 hours real work")', Math.round(rawHrs * 100) / 100, 5.74);

      console.log('\n' + pass + ' passed, ' + fail + ' failed');
      process.exit(fail > 0 ? 1 : 0);
    });
  }
}

main();
