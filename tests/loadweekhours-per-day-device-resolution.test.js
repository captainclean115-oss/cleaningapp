// PR #150 -- regression test for the Item 3 vehicle-swap GPS attribution
// feature.
//
// Root cause found in earlier research (see Item 3 investigation):
// loadWeekHours()'s Geotab-supplementary pass resolved each team's device
// ONCE for the whole week, against days[0] only:
//   const teamDeviceMap = await _resolveTeamDeviceMap(devices, teamOrder, days[0]);
//   teamDevices = teamOrder.filter(...).map(t => ({ ...teamDeviceMap[t].device, team: t }));
//   ...
//   teamDevices.forEach(dev => {
//     const devTrips = tripsByDevice[dev.id] || [];   // ONE device, locked in, for all 5 days
//     days.forEach((day, dayIdx) => { ... filters devTrips by day ... });
//   });
// A date-scoped team_device_assignments override (Item 2: a one-day
// vehicle swap) would resolve correctly for days[0] but was then reused
// for every OTHER day in the week too -- a Monday swap looked right, but
// so did every other day, using Monday's device.
//
// Fix: resolve device per team PER DAY (teamDeviceMapByDay, one map per
// weekday), and move the device lookup + trip filtering inside the
// days.forEach loop, keyed by dayIdx.
//
// Like loadweekhours-concurrency-guard.test.js, this does NOT re-implement
// loadWeekHours (400+ lines of Geotab/time_entries/depot/lunch logic) --
// it asserts the ACTUAL extracted source no longer has the old
// week-locked pattern and does have the new per-day one.
//
// Run with: node tests/loadweekhours-per-day-device-resolution.test.js

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const fnStartMarker = 'async function loadWeekHours() {';
const fnStartIdx = src.indexOf(fnStartMarker);
if (fnStartIdx === -1) {
  console.error('FAIL: could not find loadWeekHours() in index.html — did it get renamed or moved?');
  process.exit(1);
}
const fnEndMarker = '\nasync function debugTrips()';
const fnEndIdx = src.indexOf(fnEndMarker, fnStartIdx);
if (fnEndIdx === -1) {
  console.error('FAIL: could not find the end boundary of loadWeekHours() — extraction range may need updating.');
  process.exit(1);
}
const fnBody = src.slice(fnStartIdx, fnEndIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + expected + ', got ' + actual); }
}

check(
  'the old week-locked resolution (_resolveTeamDeviceMap(..., days[0])) is gone',
  /_resolveTeamDeviceMap\([^)]*,\s*days\[0\]\)/.test(fnBody),
  false
);
check(
  'device resolution now happens once PER DAY (days.map(day => _resolveTeamDeviceMap(...))',
  /teamDeviceMapByDay\s*=\s*await Promise\.all\(days\.map\(day\s*=>\s*_resolveTeamDeviceMap\(devices,\s*teamOrder,\s*day\)\)\)/.test(fnBody),
  true
);
check(
  'the old single-device-per-team-for-the-whole-week array (teamDevices) is gone',
  /const devTrips = tripsByDevice\[dev\.id\]/.test(fnBody),
  false
);

const dayLoopIdx = fnBody.indexOf('days.forEach((day, dayIdx) => {');
check('the day loop exists', dayLoopIdx !== -1, true);

const deviceLookupIdx = fnBody.indexOf('teamDeviceMapByDay[dayIdx]');
check(
  'the per-day device lookup is INSIDE the day loop (keyed by dayIdx), not resolved once before it',
  deviceLookupIdx !== -1 && dayLoopIdx !== -1 && deviceLookupIdx > dayLoopIdx,
  true
);

const tripLookupIdx = fnBody.indexOf('tripsByDevice[_dayDeviceId]');
check(
  'trip lookup for the day uses the per-day-resolved device id, not a team-locked one',
  tripLookupIdx !== -1 && tripLookupIdx > deviceLookupIdx,
  true
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
