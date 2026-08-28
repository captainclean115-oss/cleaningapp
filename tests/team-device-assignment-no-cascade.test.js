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
// Fix: blank "until" now means "today only" (effective_to = effective_from)
// instead of open-ended. A new explicit checkbox ("∞") is required to get
// the old open-ended behavior back, for the legitimate permanent-change
// case (e.g. Staff > Teams' staffTeamSaveDevice, a different, deliberately
// permanent-only screen that this fix does NOT touch).
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

function run(team, dateStr, { selectValue = 'device-x', untilValue = '', foreverChecked = false } = {}) {
  var upsertPayload = null;
  var elements = {
    ['tda-select-' + team]: { value: selectValue },
    ['tda-until-' + team]: { value: untilValue },
    ['tda-forever-' + team]: { checked: foreverChecked },
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
  // The exact reported scenario: pick a device, leave "until" blank.
  const p1 = await run('B1', '2026-08-20', { selectValue: 's3-device', untilValue: '' });
  check('picking a vehicle with "until" left blank writes effective_to = effective_from (today only) -- NOT null/open-ended', p1.effective_to, '2026-08-20');
  check('effective_from is still the date the change was made on', p1.effective_from, '2026-08-20');
  check('device_id is the picked device', p1.device_id, 's3-device');

  // Explicit open-ended opt-in via the new checkbox.
  const p2 = await run('B1', '2026-08-20', { selectValue: 's3-device', untilValue: '', foreverChecked: true });
  check('checking the "no end date" checkbox still allows an explicit open-ended change (effective_to = null)', p2.effective_to, null);

  // Explicit multi-day-but-bounded override still works.
  const p3 = await run('B1', '2026-08-20', { selectValue: 's3-device', untilValue: '2026-08-25' });
  check('an explicit "until" date is still respected as-is', p3.effective_to, '2026-08-25');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
