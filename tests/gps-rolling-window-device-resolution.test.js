// Tom's screenshot proved B1's real Aug 26 GPS data exists in Geotab
// (8:21am-7:33pm, matching what this session's direct API check already
// found), but the Live tab's "Last 30 Days" view showed a gap on the
// 26th for B1 anyway -- with data present on the 25th and 27th, which
// exactly matches the OTHER vehicle's (S3's van, borrowed by B1 for a
// single day) real trip pattern, not B1's own van's.
//
// Root cause: in rolling-window mode (3d/7d/30d), loadGPSData() resolves
// ONE device per team via _resolveTeamDeviceMap(devices, teamOrder,
// selectedDate) and then shows that ONE device's entire trip history for
// the whole window. `selectedDate` comes from the single-day date picker
// -- which is HIDDEN in rolling mode (meaningless for a multi-day span)
// but still holds whatever calendar day it was last left on. If that
// leftover day happens to fall on a team's one-day vehicle-swap override
// (team_device_assignments, effective_from = effective_to = that day),
// the ENTIRE rolling window silently locks onto the swap vehicle instead
// of the team's normal one -- so a real gap in the swap vehicle's data
// reads as a gap in the team's own data, and the team's own real
// activity on every other day in the window becomes invisible.
//
// Fix: rolling-window mode resolves off "now" (the current moment)
// instead of the single-day picker's leftover value, since that picker
// doesn't represent anything meaningful once rolling mode is selected.
//
// Run with: node tests/gps-rolling-window-device-resolution.test.js

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

const startMarker = 'const selectedDate = getGPSDate();';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find selectedDate declaration in loadGPSData'); process.exit(1); }
const endMarker = 'const teamDeviceMap = await _resolveTeamDeviceMap(devices, teamOrder, isRollingWindow ? now : selectedDate);';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find the fixed _resolveTeamDeviceMap call -- did the fix get reverted or refactored?'); process.exit(1); }
const bodySource = src.slice(startIdx, endIdx + endMarker.length);

function buildSandbox(opts) {
  const els = {
    'gps-activity-window': { value: opts.activityWindow },
  };
  let capturedDate = null;
  const sandbox = {
    console,
    window: {},
    document: { getElementById: function (id) { return els[id] || null; } },
    getGPSDate: function () { return opts.pickerDate; },
    _geotabCall: function () { return Promise.resolve([]); },
    _pentaTeamNames: function () { return ['B1']; },
    _resolveTeamDeviceMap: function (devices, teamOrder, dateArg) { capturedDate = dateArg; return Promise.resolve({}); },
  };
  vm.createContext(sandbox);
  const runner = 'async function run() {\n  var devices = [];\n' + bodySource + '\n  return teamDeviceMap;\n}\nrun();';
  const resultPromise = vm.runInContext(runner, sandbox);
  return resultPromise.then(function () { return capturedDate; });
}

async function main() {
  const stalePickerDate = new Date('2026-08-25T00:00:00');

  // Rolling window (30d): must resolve off "now", ignoring whatever the
  // hidden single-day picker is leftover-holding -- this is the actual
  // fix. Before it, this would have captured stalePickerDate instead.
  {
    const capturedDate = await buildSandbox({ activityWindow: '30d', pickerDate: stalePickerDate });
    const nowDate = new Date();
    check(
      'rolling window (30d) resolves team devices off "now", not the stale single-day picker value',
      capturedDate.toDateString(),
      nowDate.toDateString()
    );
  }

  // Same check for 3d and 7d -- any non-'24h' value is rolling mode.
  for (const mode of ['3d', '7d']) {
    const capturedDate = await buildSandbox({ activityWindow: mode, pickerDate: stalePickerDate });
    const nowDate = new Date();
    check('rolling window (' + mode + ') also resolves off "now"', capturedDate.toDateString(), nowDate.toDateString());
  }

  // Single-day mode ('24h', the default): must still use the picker's
  // date exactly as before -- this mode's whole point IS a specific day.
  {
    const capturedDate = await buildSandbox({ activityWindow: '24h', pickerDate: stalePickerDate });
    check(
      'single-day mode (24h) still resolves off the picker\'s selected date, unchanged',
      capturedDate.getTime(),
      stalePickerDate.getTime()
    );
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
