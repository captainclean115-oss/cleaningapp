// PR #150 -- behavioral integration test for Item 3: hours on a swap day
// come from the swapped-in vehicle's GPS, and the very next day (no
// override) uses the team's own default vehicle, with no cross-day
// contamination either direction.
//
// Extracts the REAL loadWeekHours() from index.html (not a
// reimplementation) and drives it with two distinct devices' trip data:
// "s3van" (an 8h trip on day 0 only, plus an unrelated/longer decoy trip
// on day 1 that must NOT be picked up) and "b1van" (a 4h trip on day 1
// only, plus a decoy on day 0). teamDeviceMapByDay is stubbed to mirror
// exactly what get_team_device (migration 105) resolves live: B1 -> s3van
// on day 0 (the Aug 20 override), B1 -> b1van on day 1 (Aug 21, back to
// default). The depot/crossref/lunch sub-algorithms are stubbed to
// trivial pass-throughs -- this test isolates the device-selection
// change, not the (separately tested/unchanged) depot-window logic.
//
// Run with: node tests/loadweekhours-vehicle-swap-attribution.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const fnStartMarker = 'async function loadWeekHours() {';
const fnStartIdx = src.indexOf(fnStartMarker);
const fnEndMarker = '\nasync function debugTrips()';
const fnEndIdx = src.indexOf(fnEndMarker, fnStartIdx);
if (fnStartIdx === -1 || fnEndIdx === -1) {
  console.error('FAIL: could not extract loadWeekHours() — did it get renamed or moved?');
  process.exit(1);
}
const fnSource = src.slice(fnStartIdx, fnEndIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const day0 = new Date(2026, 7, 20); // Aug 20 -- the swap day
const day1 = new Date(2026, 7, 21); // Aug 21 -- back to default
const days = [day0, day1, new Date(2026, 7, 22), new Date(2026, 7, 23), new Date(2026, 7, 24)];

function iso(d, h, m) { const x = new Date(d); x.setHours(h, m, 0, 0); return x.toISOString(); }

// Mirrors what get_team_device/_resolveTeamDeviceMap actually resolve live:
// day 0 -> s3van (the Aug 20 override), day 1+ -> b1van (B1's real default).
const teamDeviceMapByDay = [
  { B1: { device: { id: 's3van', name: 'S3 Van' }, source: 'assignment' } },
  { B1: { device: { id: 'b1van', name: 'B1 Van' }, source: 'assignment' } },
  { B1: { device: { id: 'b1van', name: 'B1 Van' }, source: 'assignment' } },
  { B1: { device: { id: 'b1van', name: 'B1 Van' }, source: 'assignment' } },
  { B1: { device: { id: 'b1van', name: 'B1 Van' }, source: 'assignment' } },
];

const trips = [
  // s3van: real 8h trip on day 0 (the swap), plus a DECOY 2h trip on day
  // 1 that must be ignored (day 1 no longer resolves to s3van for B1).
  { device: { id: 's3van' }, start: iso(day0, 8, 0), stop: iso(day0, 16, 0), stopAddress: 'somewhere', stopPoint: null },
  { device: { id: 's3van' }, start: iso(day1, 9, 0), stop: iso(day1, 11, 0), stopAddress: 'somewhere', stopPoint: null },
  // b1van: real 4h trip on day 1 (back to default), plus a DECOY 6h trip
  // on day 0 that must be ignored (day 0 resolves to s3van for B1, not
  // b1van -- b1van's own day-0 trip data is irrelevant to B1 that day).
  { device: { id: 'b1van' }, start: iso(day1, 9, 0), stop: iso(day1, 13, 0), stopAddress: 'somewhere', stopPoint: null },
  { device: { id: 'b1van' }, start: iso(day0, 7, 0), stop: iso(day0, 13, 0), stopAddress: 'somewhere', stopPoint: null },
];

function buildSandbox() {
  const documentStubs = {};
  ['hours-week-label', 'hours-table'].forEach(id => { documentStubs[id] = { textContent: '', innerHTML: '' }; });

  const sandbox = {
    console,
    weekHours: {},
    dailyAssignments: {},
    jobs: [],
    _weekHoursLoadToken: 0,
    hoursWeekOffset: 0,
    getWeekDates: () => days,
    document: { getElementById: (id) => documentStubs[id] || { textContent: '', innerHTML: '', style: {} } },
    window: {
      PentaLunchFlags: null,
      PentaAssignments: null,
      PentaEmployees: null,
      supabaseClient: null, // no time_entries source -- forces Geotab-only, matching Manna's real current state
      PentaTenant: { current: () => null },
    },
    _mirrorPentaAssignmentsToInMemory: () => {},
    _pentaTeamNames: () => ['B1'],
    _pentaTeamColor: () => '#000',
    _geotabCall: (method, params) => {
      if (params && params.typeName === 'Device') return Promise.resolve([{ id: 's3van', name: 'S3 Van' }, { id: 'b1van', name: 'B1 Van' }]);
      if (params && params.typeName === 'Trip') return Promise.resolve(trips);
      return Promise.resolve([]);
    },
    _resolveTeamDeviceMap: (devices, teamOrder, dateObj) => {
      const idx = days.findIndex(d => d.toDateString() === dateObj.toDateString());
      return Promise.resolve(teamDeviceMapByDay[idx] || {});
    },
    reverseGeocodeTrips: () => Promise.resolve(),
    getDepotForTeam: () => null,
    isDepotAddress: () => false,
    isDepotPoint: () => false,
    dateKey: (d) => d.toISOString().slice(0, 10),
    _findJobCrossrefStartEnd: () => ({ matched: false }),
    _findTrueDepotDepartureTrip: (validTrips) => ({ depotArrivalsAsc: [], trueStartTrip: validTrips[0] }),
    _detectDayLunch: () => null,
    loadLunchEdits: () => {},
    _reconcileHoursWithLunch: () => {},
    _writeWeekHoursCache: () => {},
    renderHoursTable: () => {},
  };
  sandbox.window._empHoursMap = {};
  sandbox.window._hoursGeotabAvailable = false;
  vm.createContext(sandbox);
  return sandbox;
}

(async () => {
  const sandbox = buildSandbox();
  vm.runInContext(fnSource, sandbox);
  await sandbox.loadWeekHours();

  const b1 = sandbox.weekHours['B1'];
  if (!b1) { console.error('FAIL: weekHours.B1 was never populated'); process.exit(1); }

  check('Aug 20 (swap day): B1 hours computed from S3\'s van (8h trip), not B1\'s own van\'s decoy trip', b1.days[0], 8);
  check('Aug 21 (back to default): B1 hours computed from B1\'s own van (4h trip), not S3\'s van\'s decoy trip', b1.days[1], 4);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) {
  console.error('FAIL: test threw', e);
  process.exit(1);
});
