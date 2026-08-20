// PR #135 — regression test: _detectDayLunch must not flag a stop
// outside the actual computed workday (trueStart..trueEnd) as lunch.
// Extracts and runs the ACTUAL _detectDayLunch source from index.html
// (not a reimplementation) against Tom's real reported scenario: an M3
// employee returns to the office (true end) at 4:22 PM, then drives the
// vehicle home and stops at a store at 5:15 PM for 30 min -- personal,
// not lunch, and must not be deducted from the payroll total.
//
// Run with: node tests/lunch-detection-bounded.test.js
// No dependencies beyond Node's built-ins (fs, vm).

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error('extraction failed: could not find start marker: ' + startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('extraction failed: could not find end marker after start: ' + endMarker);
  return src.slice(startIdx, endIdx);
}

const detectDayLunchSrc = extract('\nfunction _detectDayLunch(', '\nasync function loadWeekHours()');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function runDetectDayLunch(dayTrips, trueStart, trueEnd) {
  const sandbox = {
    console: console,
    window: {}, // no PentaLunchFlags -- override pass is skipped, fine for these cases
    // Dependencies of _detectDayLunch, stubbed at the boundary (NOT the
    // function under test) -- address-aware so the depot stop and real
    // client stop in the test fixtures are correctly excluded, same as
    // the real isDepotAddress/matchStopToClientGeo would do.
    isDepotAddress: function (addr) { return addr === '910 Boston Post Rd'; },
    isDepotPoint: function () { return false; },
    matchStopToClientGeo: function (lat, lng, addr) { return addr === '1 Client St' ? { id: 'c1', scheduled: true } : null; },
  };
  vm.createContext(sandbox);
  vm.runInContext(detectDayLunchSrc, sandbox);
  return vm.runInContext(
    '_detectDayLunch(__dayTrips, "M3", [], "2026-08-20", __trueStart, __trueEnd)',
    Object.assign(sandbox, { __dayTrips: dayTrips, __trueStart: trueStart, __trueEnd: trueEnd })
  );
}

console.log('Testing extracted _detectDayLunch() from index.html\n');

// Tom's exact reported scenario: M3 returns to office (trueEnd) at
// 4:22 PM, drives home, stops at a store 4:32-5:15 PM (personal).
const trueStart = new Date('2026-08-20T13:00:00.000Z'); // 9:00 AM ET
const trueEnd = new Date('2026-08-20T20:22:00.000Z');   // 4:22 PM ET -- last office return

const dayTripsWithPostWorkdayStop = [
  { start: '2026-08-20T13:00:00.000Z', stop: '2026-08-20T17:30:00.000Z', stopAddress: '1 Client St' },
  { start: '2026-08-20T17:30:00.000Z', stop: '2026-08-20T20:22:00.000Z', stopAddress: '910 Boston Post Rd' }, // arrives at true end, 4:22 PM
  { start: '2026-08-20T20:32:00.000Z', stop: '2026-08-20T21:15:00.000Z', stopAddress: 'Somewhere personal' }, // drove home 4:32 PM, arrived at a store 5:15 PM
  { start: '2026-08-20T21:45:00.000Z', stop: null }, // left the store 5:45 PM (30 min stop), still driving
];

const resultPostWorkday = runDetectDayLunch(dayTripsWithPostWorkdayStop, trueStart, trueEnd);
check('post-end-time personal stop (5:15 PM, after 4:22 PM true end) is NOT flagged as lunch', resultPostWorkday, null);

// Same trips, but WITHOUT trueStart/trueEnd passed (old call signature)
// -- must reproduce the bug exactly, proving this is a real fix and not
// a no-op change in disguise.
const resultNoBounds = runDetectDayLunch(dayTripsWithPostWorkdayStop, undefined, undefined);
check('without trueStart/trueEnd (old behavior), the post-workday stop DOES get wrongly flagged -- proves the bug was real', !!resultNoBounds, true);

// A genuine mid-day lunch stop must still be detected once bounded.
const dayTripsWithRealLunch = [
  { start: '2026-08-20T13:00:00.000Z', stop: '2026-08-20T17:00:00.000Z', stopAddress: '1 Client St' },
  { start: '2026-08-20T17:30:00.000Z', stop: '2026-08-20T18:00:00.000Z', stopAddress: 'Lunch spot' }, // 30 min real lunch, mid-day
  { start: '2026-08-20T18:30:00.000Z', stop: '2026-08-20T20:22:00.000Z', stopAddress: '910 Boston Post Rd' },
];
const resultRealLunch = runDetectDayLunch(dayTripsWithRealLunch, trueStart, trueEnd);
check('a genuine mid-day lunch stop is still detected after bounding', resultRealLunch && resultRealLunch.duration, 30);

// A stop BEFORE trueStart (symmetric case -- e.g. a pre-shift personal
// errand) must also not be flagged.
const dayTripsWithPreShiftStop = [
  { start: '2026-08-20T12:00:00.000Z', stop: '2026-08-20T12:45:00.000Z', stopAddress: 'Personal errand before shift' }, // 45 min, ends before trueStart
  { start: '2026-08-20T13:00:00.000Z', stop: '2026-08-20T20:22:00.000Z', stopAddress: '910 Boston Post Rd' },
];
const resultPreShift = runDetectDayLunch(dayTripsWithPreShiftStop, trueStart, trueEnd);
check('a pre-shift personal stop (before true start) is NOT flagged as lunch', resultPreShift, null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
