// PR #149 -- regression test for a daily GPS vehicle override cascading
// forward into the team's permanent default.
//
// Reported: Tom moved B1's car to S3 for Aug 20 only, via the Team Manager
// vehicle picker. Every day AFTER Aug 20 then also showed S3's car as B1's
// default. Confirmed live: the write went to team_device_assignments (the
// correct, already date-scoped-CAPABLE table), but with effective_to=null.
// get_team_device's resolver (migration 080) treats a null effective_to as
// "until 9999-12-31" -- open-ended by design, for the legitimate case of
// permanently changing a team's default vehicle.
//
// Root cause wasn't the table or the resolver -- both already correctly
// support date scoping. It was setTeamDeviceAssignment(): the vehicle
// <select> fires the write immediately on onchange, using whatever's in
// the separate "until" date input at that exact moment. The ordinary
// interaction (open dropdown, pick a car) leaves "until" blank, since
// there's no natural moment to fill it in first -- so every plain vehicle
// pick silently became a permanent, forward-cascading change.
//
// PR #149's fix: blank "until" meant "today only" instead of open-ended,
// with a new "∞" checkbox as the explicit opt-in for the old open-ended
// behavior.
//
// Follow-up cleanup (post-#150): Tom confirmed a car change from THIS
// picker should ALWAYS be scoped to the viewed day only -- there's no
// legitimate case for open-ended from here at all. The "until" input and
// "∞" checkbox were removed outright; setTeamDeviceAssignment no longer
// reads any element besides the vehicle <select> itself, and always
// writes effective_from = effective_to = dateStr. The permanent-default
// case lives solely in Admin/Staff → Teams' staffTeamSaveDevice now (a
// different, always-open-ended screen that was never driven by these two
// removed elements in the first place).
//
// Run with: node tests/team-device-assignment-no-cascade.test.js

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

const fnSource = extract('async function setTeamDeviceAssignment(team, dateStr) {', '\n\n// PR #118', 'setTeamDeviceAssignment');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function run(team, dateStr, selectValue) {
  var upsertPayload = null;
  var elements = {
    ['tda-select-' + team]: { value: selectValue },
  };
  const sandbox = {
    console,
    document: { getElementById: (id) => elements[id] || null },
    window: {
      supabaseClient: {
        from: () => ({
          upsert: (payload) => { upsertPayload = payload; return Promise.resolve({ error: null }); },
        }),
      },
      PentaTenant: { current: () => 'biz-1' },
    },
    alert: () => {},
    _invalidateTmgrGpsCache: () => {},
    renderTeamManager: () => {},
  };
  vm.createContext(sandbox);
  return vm.runInContext(fnSource + '\nsetTeamDeviceAssignment', sandbox)(team, dateStr).then(() => upsertPayload);
}

(async () => {
  // The exact reported scenario: pick a device.
  const p1 = await run('B1', '2026-08-20', 's3-device');
  check('picking a vehicle always writes effective_to = effective_from (today only)', p1.effective_to, '2026-08-20');
  check('effective_from is the date the change was made on', p1.effective_from, '2026-08-20');
  check('device_id is the picked device', p1.device_id, 's3-device');

  // No way left to request open-ended from this function -- always day-scoped,
  // regardless of which device/date is picked.
  const p2 = await run('B1', '2026-08-20', 's3-device');
  check('there is no opt-in left for open-ended -- always day-scoped', p2.effective_to, '2026-08-20');

  const p3 = await run('B1', '2026-08-25', '__none__');
  check('"None (no GPS coverage)" is also day-scoped, not open-ended', p3.effective_to, '2026-08-25');
  check('device_id is null for explicit no-GPS', p3.device_id, null);

  const p4 = await run('B1', '2026-08-26', '');
  check('"Default" option is day-scoped too', p4.effective_to, '2026-08-26');
  check('device_id is the __default__ sentinel', p4.device_id, '__default__');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
