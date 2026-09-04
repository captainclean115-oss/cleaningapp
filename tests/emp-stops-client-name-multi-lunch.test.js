// Tom: "when i look at recorded stops it will show them good when i hit
// b1 or whatever, but when i go to an employee and hit a certain day its
// not the same..multiple lunches do not show and it does not show the
// clients names like it does on the regular trips view."
//
// showEmpStops() (the inline Stops list inside the employee day-detail
// overlay, opened by tapping an Hours-table day cell) was a stale,
// independently-diverged copy of the Live tab's trip-to-stop-list
// construction (_renderGPSStopRow): it never called matchStopToClientGeo
// at all (raw address only), and it could only ever highlight ONE stop
// as "lunch" (lunchStopIdx, matched against _detectDayLunch's summed
// duration's FIRST candidate time only) even on a day with several
// independently-qualifying short stops -- the Live tab evaluates every
// stop's own naturallyLunch status independently.
//
// Fix reuses the same two building blocks the Live tab already uses
// (matchStopToClientGeo, PentaLunchFlags) instead of re-diverging with a
// third copy. Deliberately does NOT touch the existing lunchStopIdx /
// _empLunchStop / setLunchStop mechanism -- that's a separate "tap a stop
// to quick-fill the manual Lunch(min) override field" helper Tom didn't
// report anything wrong with.
//
// Run with: node tests/emp-stops-client-name-multi-lunch.test.js

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

const startMarker = 'async function showEmpStops(team, dateMs) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find showEmpStops()'); process.exit(1); }
const endMarker = '\n\n// ROUTE DETAIL MODAL FROM EMPLOYEE HOURS';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find showEmpStops end boundary'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx);

// Fixture: one workday with TWO independent short unmatched stops (should
// both be flagged as possible lunch, matching what the Live tab already
// shows for the same trips) plus one real client visit (should resolve a
// name) and the depot bookends.
const DEPOT = { addr: '800 Brockton Ave, Abington', lat: 42.0932067, lng: -70.9687121 };
const CLIENT = { id: 'client-1', fn: 'Pat', ln: 'Villani', lat: 42.2290113, lng: -70.8735098 };

function buildTrips() {
  return [
    { start: '2026-08-26T12:21:29.000Z', stop: '2026-08-26T12:21:44.000Z', startAddress: DEPOT.addr, startPoint: { y: DEPOT.lat, x: DEPOT.lng }, stopAddress: DEPOT.addr, stopPoint: { y: DEPOT.lat, x: DEPOT.lng } },
    { start: '2026-08-26T12:44:11.000Z', stop: '2026-08-26T12:57:34.000Z', stopAddress: '1002 Main St, Weymouth', stopPoint: { y: 42.21, x: -70.95 } }, // short unmatched stop #1 -- possible lunch
    { start: '2026-08-26T13:16:55.000Z', stop: '2026-08-26T14:22:00.000Z', stopAddress: '80 Pleasant Street', stopPoint: { y: CLIENT.lat, x: CLIENT.lng } }, // real client visit, long -- not lunch
    { start: '2026-08-26T14:44:31.000Z', stop: '2026-08-26T14:50:49.000Z', stopAddress: '664 Washington St, Quincy', stopPoint: { y: 42.25, x: -70.99 } }, // short unmatched stop #2 -- also possible lunch (stays parked ~29min before the next trip)
    { start: '2026-08-26T15:19:40.000Z', stop: '2026-08-26T15:37:00.000Z', stopAddress: DEPOT.addr, stopPoint: { y: DEPOT.lat, x: DEPOT.lng } },
  ];
}

function buildSandbox(opts) {
  opts = opts || {};
  const els = { 'emp-stops-area': { innerHTML: '' }, 'emp-hr-team': null };
  const sandbox = {
    console,
    document: { getElementById: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; } },
    localStorage: { getItem: function () { return null; } }, // no manual _empLunchStop override in these tests
    window: { PentaLunchFlags: { getOverride: opts.getOverride || function () { return null; } } },
    jobs: [],
    weekHours: {},
    hoursWeekOffset: 0,
    getWeekDates: function () { return [new Date('2026-08-26T00:00:00')]; },
    dateKey: function (d) { return d.toISOString().slice(0, 10); },
    fmt12: function (d) { return d.toISOString().slice(11, 16); },
    isDepotAddress: function (addr) { return !!addr && addr.indexOf(DEPOT.addr) !== -1; },
    isDepotPoint: function (pt) { return !!pt && Math.abs(pt.y - DEPOT.lat) < 0.01 && Math.abs(pt.x - DEPOT.lng) < 0.01; },
    matchStopToClientGeo: function (lat, lng, addr, teamJobs, team) {
      if (lat == null || lng == null) return null;
      if (Math.abs(lat - CLIENT.lat) < 0.01 && Math.abs(lng - CLIENT.lng) < 0.01) {
        return { name: (CLIENT.fn + ' ' + CLIENT.ln).trim(), id: CLIENT.id, confidence: 'medium', scheduled: false, distFt: 10 };
      }
      return null;
    },
    _geotabCallRetryOn429: function (method, params) {
      if (params.typeName === 'Device') return Promise.resolve([{ id: 'b10D', name: 'B1' }]);
      if (params.typeName === 'Trip') return Promise.resolve(buildTrips());
      return Promise.resolve([]);
    },
    _resolveTeamDevice: function () { return Promise.resolve({ device: { id: 'b10D', name: 'B1' }, source: 'assignment' }); },
    reverseGeocodeTrips: function (trips) { return Promise.resolve(trips); },
    _toggleLunchOverride: function () {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, els };
}

async function main() {
  const { sandbox, els } = buildSandbox();
  await sandbox.showEmpStops('B1', new Date('2026-08-26T00:00:00').getTime());
  const html = els['emp-stops-area'].innerHTML;

  check('the real client visit shows the resolved client name', html.indexOf('Pat Villani') !== -1, true);
  check('the raw address is still shown as a secondary line under the client name (not replaced)', html.indexOf('80 Pleasant Street') !== -1, true);

  const lunchTagCount = (html.match(/Possible lunch \/ break/g) || []).length;
  check('BOTH independent short unmatched stops are flagged as possible lunch (not just one)', lunchTagCount, 2);

  const notLunchButtonCount = (html.match(/✕ Not lunch/g) || []).length;
  check('each flagged stop gets its own "Not lunch" toggle button', notLunchButtonCount, 2);

  check('the real client stop (matched, long duration) is NOT flagged as possible lunch', html.indexOf('80 Pleasant Street') < html.indexOf('Possible lunch') || lunchTagCount === 2, true);

  // A stop already excluded via PentaLunchFlags shows the reversed state, not the auto-flag.
  const { els: els2 } = await (async () => {
    const built = buildSandbox({
      getOverride: function (team, dateStr, stopKey) {
        if (stopKey === '2026-08-26T12:57:34.000Z') return { override_type: 'exclude' };
        return null;
      },
    });
    await built.sandbox.showEmpStops('B1', new Date('2026-08-26T00:00:00').getTime());
    return built;
  })();
  const html2 = els2['emp-stops-area'].innerHTML;
  check('an excluded stop shows "Marked not-lunch" instead of the auto-flag', html2.indexOf('Marked not-lunch') !== -1, true);
  check('an excluded stop is NOT counted as "Possible lunch" anymore', (html2.match(/Possible lunch \/ break/g) || []).length, 1);
  check('an excluded stop gets a "Mark as lunch" reversal button', html2.indexOf('🍔 Mark as lunch') !== -1, true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
