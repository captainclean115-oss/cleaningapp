// PR #142 — regression test for the Joana/S3 GPS-end-time bug's
// short-term fix (Path A, per Tom's diagnosis follow-up). Root cause:
// _resolveTeamDevice fell back to guessing a device by
// name.toUpperCase().includes(team) across every live Geotab device
// whenever team_device_assignments had NO row covering that team+date
// (a genuine coverage gap, later backfilled after the fact -- but by
// then the wrong number was already shown/cached, and there was no way
// to tell after the fact whether the guess had landed on the right
// vehicle). Fix: team_device_assignments is now the only source of
// truth. A coverage gap resolves to "no device" instead of a guess.
//
// The OTHER branch -- an explicit assignment row found, but the
// resolved device's live Geotab name doesn't match the team code
// (PR #123's mismatch warning) -- was already correct before this fix
// (still returns the assigned device, never swaps). This test proves
// that stays true, so a future edit can't quietly reintroduce a swap
// there either.
//
// Extracts the real _resolveTeamDevice source from index.html and runs
// it against a mocked Supabase RPC, rather than reimplementing its
// logic — a reimplementation could pass while the real function still
// has the bug.
//
// Run with: node tests/resolve-team-device-no-name-fallback.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const fnStart = 'async function _resolveTeamDevice(devices, team, dateObj) {';
const fnStartIdx = src.indexOf(fnStart);
if (fnStartIdx === -1) {
  console.error('FAIL: could not find _resolveTeamDevice in index.html — did it get renamed or moved?');
  process.exit(1);
}
const fnEndIdx = src.indexOf('\nasync function _resolveTeamDeviceMap(', fnStartIdx);
if (fnEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after _resolveTeamDevice — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(fnStartIdx, fnEndIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// A device deliberately named so a name-matching guess (if it still
// existed) WOULD pick it for team 'S3' -- proves its absence when it's
// NOT the one returned.
const DEVICE_THAT_WOULD_WIN_BY_NAME_MATCH = { id: 'wrong-vehicle', name: 'Backup S3 Van (spare)' };
const ASSIGNED_DEVICE = { id: 'b12', name: 'B12' }; // real S3 vehicle, name does NOT contain "S3"
const DEVICES = [DEVICE_THAT_WOULD_WIN_BY_NAME_MATCH, ASSIGNED_DEVICE];

function buildSandbox(rpcImpl) {
  const sandbox = {
    console: console,
    dateKey: function (d) { return '2026-08-25'; },
    window: {
      supabaseClient: { rpc: rpcImpl },
      PentaTenant: { current: function () { return 'biz-1'; } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

(async function () {
  // --- The actual bug: RPC returns zero rows (coverage gap) ---
  {
    const sandbox = buildSandbox(function () { return Promise.resolve({ error: null, data: [] }); });
    const result = await sandbox._resolveTeamDevice(DEVICES, 'S3', new Date());
    check('coverage gap (RPC returns 0 rows): no device is guessed by name', result.device, null);
    check('coverage gap: source is no-assignment, not a name-match', result.source, 'no-assignment');
  }

  // --- RPC itself fails (network/permission error) ---
  {
    const sandbox = buildSandbox(function () { return Promise.reject(new Error('network down')); });
    const result = await sandbox._resolveTeamDevice(DEVICES, 'S3', new Date());
    check('RPC failure: no device is guessed by name either', result.device, null);
    check('RPC failure: source is no-assignment, not a name-match', result.source, 'no-assignment');
  }

  // --- Explicit assignment, device_id = NULL ("deliberately no GPS") ---
  {
    const sandbox = buildSandbox(function () { return Promise.resolve({ error: null, data: [{ device_id: null }] }); });
    const result = await sandbox._resolveTeamDevice(DEVICES, 'S3', new Date());
    check('deliberate no-GPS assignment is respected as-is', result, { device: null, source: 'assignment-none', rawDeviceId: null });
  }

  // --- Explicit assignment found, but its live Geotab name doesn't match the team (PR #123 case) ---
  {
    const sandbox = buildSandbox(function () { return Promise.resolve({ error: null, data: [{ device_id: 'b12' }] }); });
    const result = await sandbox._resolveTeamDevice(DEVICES, 'S3', new Date());
    check('name-mismatched assignment still returns the ASSIGNED device (b12), not swapped', result.device && result.device.id, 'b12');
    check('name-mismatched assignment source is "assignment", not a fallback', result.source, 'assignment');
    check('mismatch flag is still raised for the PR #123 warning banner', result.mismatch, true);
  }

  // --- Explicit assignment found, device id not in today's live Geotab list ---
  {
    const sandbox = buildSandbox(function () { return Promise.resolve({ error: null, data: [{ device_id: 'deactivated-device' }] }); });
    const result = await sandbox._resolveTeamDevice(DEVICES, 'S3', new Date());
    check('assigned device missing from live list: device is null', result.device, null);
    check('assigned device missing from live list: source is assignment-missing, not a name-match guess', result.source, 'assignment-missing');
    check('rawDeviceId is preserved for the missing-device UI', result.rawDeviceId, 'deactivated-device');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
