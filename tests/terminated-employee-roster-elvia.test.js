// Terminated-employee date-awareness fix -- real-shaped fixture test
// using Elvia Tonato's REAL data: team B1, terminated 2026-08-19
// (confirmed via a read-only query against the live database during
// this task's investigation -- her 58 real daily_assignments rows
// dated 2026-05-11 through 2026-08-27 all have deleted_at=null for
// every date BEFORE 2026-08-19, confirming the stored data itself was
// always intact; this test proves the READ side now surfaces it
// correctly too, which it did not before this fix).
//
// Against the REAL extracted getUnifiedRoster/getEmployeeTeam/
// getTeamEmployees/_hrsEffectiveTeamForRange -- not a reimplementation.
//
// Run with: node tests/terminated-employee-roster-elvia.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label, fromIndex) {
  const s = src.indexOf(startMarker, fromIndex || 0);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return { text: src.slice(s, e), endIdx: e };
}

const rosterResult = extract('function getUnifiedRoster(asOfDate) {', '\n\n\n// Daily assignments', 'getUnifiedRoster');
const teamFnsResult = extract('function getEmployeeTeam(employeeId, dateStr) {', '\n\nasync function assignEmployee(employeeId, team, dateStr, extra) {', 'getEmployeeTeam/getTeamEmployees', rosterResult.endIdx);
const effTeamResult = extract('function _hrsEffectiveTeamForRange(emp, dateKeys) {', '\n}\n', '_hrsEffectiveTeamForRange');
const fnSource = rosterResult.text + '\n' + teamFnsResult.text + '\n' + effTeamResult.text + '\n}\n';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// Real shape: Elvia Tonato, team B1, terminated 2026-08-19. Katia Mejia,
// a real still-active B1 teammate (confirmed live alongside Elvia in the
// same team during the investigation), for the teammate-impact proof.
const ELVIA = { id: 'elvia-id', legacy_roster_id: null, name: 'Elvia Tonato', team: 'B1', team_text: 'B1', status: 'terminated', terminated_at: '2026-08-19', role: [] };
const KATIA = { id: 'katia-id', legacy_roster_id: null, name: 'Katia Mejia', team: 'B1', team_text: 'B1', status: 'active', terminated_at: null, role: [] };

function buildSandbox(dailyAssignmentsOverride) {
  const sandbox = {
    console,
    EMPLOYEE_ROSTER: [],
    dailyAssignments: dailyAssignmentsOverride || {},
    window: { PentaEmployees: { listSync: function () { return [ELVIA, KATIA]; } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

function dateKeysForWeek(mondayStr) {
  const out = [];
  let d = new Date(mondayStr + 'T00:00:00');
  for (let i = 0; i < 5; i++) {
    out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

function main() {
  // ---- Week of Jul 6 (well before her Aug 19 termination): shows her exactly as the raw data says ----
  {
    const weekKeys = dateKeysForWeek('2026-07-06'); // Mon-Fri Jul 6-10
    const sandbox = buildSandbox();
    const roster = sandbox.getUnifiedRoster(weekKeys[0]);
    check('Elvia is included in the roster for the week of Jul 6 (first day of range)', roster.some((e) => e.id === 'elvia-id'), true);
    const teamEmployees = roster.filter((e) => sandbox._hrsEffectiveTeamForRange(e, weekKeys) === 'B1');
    check('she is grouped under B1 (her real team, unchanged this far before termination)', teamEmployees.some((e) => e.id === 'elvia-id'), true);
    const b1ForJul8 = sandbox.getTeamEmployees('B1', weekKeys[2]);
    check('getTeamEmployees includes her for a specific day in that week (Jul 8)', b1ForJul8.some((e) => e.id === 'elvia-id'), true);
    check('her teammate Katia is unaffected -- also included, same day', b1ForJul8.some((e) => e.id === 'katia-id'), true);
  }

  // ---- The week containing Aug 19 (Mon Aug 17 - Fri Aug 21): shows her only for days BEFORE D ----
  {
    const weekKeys = dateKeysForWeek('2026-08-17'); // Mon 17, Tue 18, Wed 19, Thu 20, Fri 21
    const sandbox = buildSandbox();
    const roster = sandbox.getUnifiedRoster(weekKeys[0]); // asOfDate = first day of range (Aug 17, before D)
    check('she is still included in this week\'s roster (the range starts before her termination)', roster.some((e) => e.id === 'elvia-id'), true);

    check('Mon Aug 17 (before D): she resolves to B1', sandbox.getEmployeeTeam('elvia-id', weekKeys[0]), 'B1');
    check('Tue Aug 18 (before D): she resolves to B1', sandbox.getEmployeeTeam('elvia-id', weekKeys[1]), 'B1');
    check('Wed Aug 19 (ON D -- the documented exclusive rule): she resolves to null, not B1', sandbox.getEmployeeTeam('elvia-id', weekKeys[2]), null);
    check('Thu Aug 20 (after D): she resolves to null', sandbox.getEmployeeTeam('elvia-id', weekKeys[3]), null);
    check('Fri Aug 21 (after D): she resolves to null', sandbox.getEmployeeTeam('elvia-id', weekKeys[4]), null);

    check('getTeamEmployees for Mon Aug 17 (before D) includes her', sandbox.getTeamEmployees('B1', weekKeys[0]).some((e) => e.id === 'elvia-id'), true);
    check('getTeamEmployees for Wed Aug 19 (on D) excludes her', sandbox.getTeamEmployees('B1', weekKeys[2]).some((e) => e.id === 'elvia-id'), false);
    check('getTeamEmployees for Fri Aug 21 (after D) excludes her', sandbox.getTeamEmployees('B1', weekKeys[4]).some((e) => e.id === 'elvia-id'), false);

    check('Katia (teammate) is included on EVERY day of this week regardless of Elvia\'s status', weekKeys.every((dk) => sandbox.getTeamEmployees('B1', dk).some((e) => e.id === 'katia-id')), true);
  }

  // ---- The week AFTER her termination (Mon Aug 24 onward): no row for her at all ----
  {
    const weekKeys = dateKeysForWeek('2026-08-24');
    const sandbox = buildSandbox();
    const roster = sandbox.getUnifiedRoster(weekKeys[0]);
    check('she is excluded from the roster entirely for a week that starts after her termination', roster.some((e) => e.id === 'elvia-id'), false);
    check('Katia (teammate) is still included, unaffected', roster.some((e) => e.id === 'katia-id'), true);
    weekKeys.forEach((dk) => {
      check('getTeamEmployees excludes her for ' + dk, sandbox.getTeamEmployees('B1', dk).some((e) => e.id === 'elvia-id'), false);
    });
  }

  // ---- Team-card grouping: her cleared default team never lands her in "Unassigned" for a week she worked ----
  // Real daily_assignments rows are explicit per-day (confirmed live for
  // Elvia: 58 rows, including OFF placeholders, spanning her whole
  // tenure) -- Mon/Tue of this week have explicit B1 assignment rows,
  // the realistic shape, not a bare defaultTeam fallback.
  {
    const weekKeys = dateKeysForWeek('2026-08-17');
    // Simulate termination's real effect: _setEmployeeDefaultTeam clears
    // team/team_text to '' going forward. defaultTeam on the roster row
    // reflects that CURRENT (cleared) state even when asOfDate is in the past.
    const clearedElvia = Object.assign({}, ELVIA, { team: '', team_text: '' });
    const sandbox2 = buildSandbox({
      [weekKeys[0] + '_elvia-id']: 'B1',
      [weekKeys[1] + '_elvia-id']: 'B1',
    });
    sandbox2.window.PentaEmployees.listSync = function () { return [clearedElvia, KATIA]; };
    const roster = sandbox2.getUnifiedRoster(weekKeys[0]);
    const elviaRow = roster.find((e) => e.id === 'elvia-id');
    check('her defaultTeam is blank on the roster row (termination already cleared it)', elviaRow.defaultTeam, null);
    const effectiveTeam = sandbox2._hrsEffectiveTeamForRange(elviaRow, weekKeys);
    check('_hrsEffectiveTeamForRange still resolves her to B1 (the team she actually worked that week, via the real explicit daily_assignments rows), never Unassigned', effectiveTeam, 'B1');
  }

  // ---- Known limitation, documented not silently assumed away: a day with
  // NO explicit daily_assignments row that relied purely on the default-
  // team fallback cannot recover its historical team once that default is
  // cleared at termination -- the value was overwritten, not historized.
  // In production this is a narrow edge case (the daily schedule-generation
  // process appears to write an explicit row for essentially every real
  // calendar day -- confirmed live for Elvia: 58 rows including OFF
  // placeholders for days she didn't even work), but it is a genuine data-
  // model limitation, not something this fix can close at the application
  // layer without a much larger change (e.g. terminateEmployee backfilling
  // an explicit historical row before clearing the default, which this PR
  // does not do).
  {
    const weekKeys = dateKeysForWeek('2026-08-17');
    const clearedElvia = Object.assign({}, ELVIA, { team: '', team_text: '' });
    const sandbox3 = buildSandbox({}); // no explicit overrides at all this week
    sandbox3.window.PentaEmployees.listSync = function () { return [clearedElvia, KATIA]; };
    const elviaRow = sandbox3.getUnifiedRoster(weekKeys[0]).find((e) => e.id === 'elvia-id');
    const effectiveTeam = sandbox3._hrsEffectiveTeamForRange(elviaRow, weekKeys);
    check('KNOWN LIMITATION: with zero explicit per-day rows and a cleared default, the historical team cannot be recovered (documented, not silently hidden)', effectiveTeam, null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
