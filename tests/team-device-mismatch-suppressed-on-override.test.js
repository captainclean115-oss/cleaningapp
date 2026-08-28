// PR #150 -- regression test for the PR #123 GPS device-mismatch banner
// firing on deliberate daily vehicle swaps.
//
// PR #123's mismatch check flags when a team's assigned device's CURRENT
// Geotab name doesn't contain the team code -- built to catch the M1/M3
// incident (devices silently renamed, assignment never re-synced, nobody
// noticed for weeks). But a deliberate daily swap (Item 3: "B1 borrows
// S3's van for a day") makes this look IDENTICAL: B1's resolved device
// that day is legitimately named something that doesn't contain "B1".
// Without suppression, every intentional swap would trigger the same
// warning as a real silent-drift bug.
//
// Fix: get_team_device (migration 105) now also returns is_override
// (true when the resolved row is date-scoped, i.e. effective_to IS NOT
// NULL -- false for a team's open-ended default). _resolveTeamDevice only
// computes `mismatch` when is_override is false, so the warning stays
// fully live for the real permanent-drift case.
//
// Run with: node tests/team-device-mismatch-suppressed-on-override.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const fnSource = extract('async function _resolveTeamDevice(devices, team, dateObj) {', '\n\n// Batch variant', '_resolveTeamDevice');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function run(deviceId, isOverride, liveDeviceName) {
  const devices = [{ id: deviceId, name: liveDeviceName }];
  const sandbox = {
    console,
    dateKey: () => '2026-08-20',
    window: {
      supabaseClient: {
        rpc: (fn, args) => Promise.resolve({ data: [{ device_id: deviceId, is_override: isOverride }], error: null }),
      },
      PentaTenant: { current: () => 'biz-1' },
    },
  };
  vm.createContext(sandbox);
  return vm.runInContext(fnSource + '\n_resolveTeamDevice', sandbox)(devices, 'B1', new Date());
}

(async () => {
  // The exact reported scenario: B1 borrows S3's van (named "S3 Van") for
  // a date-scoped override.
  const overrideResult = await run('s3-device', true, 'S3 Van');
  check('a device with a name that does NOT contain the team code, resolved via a date-scoped OVERRIDE, does NOT flag mismatch (deliberate daily swap)', overrideResult.mismatch, false);
  check('the resolved device itself is still returned correctly (the swap still works, only the warning is suppressed)', overrideResult.device && overrideResult.device.id, 's3-device');
  check('isOverride is surfaced on the result', overrideResult.isOverride, true);

  // The real bug PR #123 exists to catch: same name mismatch, but this IS
  // the team's permanent/default assignment (not a daily override).
  const permanentResult = await run('b1-device', false, 'M3 (renamed)');
  check('a device with a mismatched name, resolved as the PERMANENT default (not an override), STILL flags mismatch -- the real drift case must keep working', permanentResult.mismatch, true);

  // Sanity: a correctly-named permanent assignment never mismatches either way.
  const cleanResult = await run('b1-device', false, 'B1 Van');
  check('a correctly-named permanent assignment does not mismatch', cleanResult.mismatch, false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
