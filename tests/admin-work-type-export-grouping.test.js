// Admin/Office employee designation (migration 113) -- Export Hours
// Report (_buildHoursReportFromData) grouping.
//
// Covers, against the REAL extracted source:
//   1. An Admin/Office employee appears exactly once, under an
//      "ADMIN / OFFICE" section, with the same text/CSV layout field
//      employees get.
//   2. No override on file -> blank ("—"), never "0:00" claimed as a
//      real entry, and never an error.
//   3. An explicit OFF/vacation day shows the real status, not a
//      zeroed/blank day indistinguishable from "nothing happened".
//   4. Admin hours are included in the SAME grandHours/empsSeen totals
//      the team sections feed -- one combined report, not two.
//   5. The PR #180/#186 fragmentation fix (a cross-team field employee
//      appearing ONCE with a combined weekly total) still works
//      correctly alongside an Admin/Office employee in the same report
//      -- the two code paths don't interact, but this proves it, not
//      just asserts it.
//
// Run with: node tests/admin-work-type-export-grouping.test.js

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

const helpersSrc = extract(
  'function _hrTo24hr(d) {',
  '\n\n// Tom: Export Hours Report',
  '_hr* CSV/formatting helpers'
);
const buildReportSrc = extract(
  'function _buildHoursReportFromData(dates, weekHoursData, teams) {',
  '\n\nfunction _hrDownloadCsv(',
  '_buildHoursReportFromData'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']; // Mon-Fri

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [];
  const overrides = opts.overrides || {}; // { empId: { date: {start,end,lunch,hours} } }
  const offDays = opts.offDays || {}; // { 'empId|date': {status_type, label} }
  const teamByEmpDate = opts.teamByEmpDate || {}; // { 'empId|date': team }

  const sandbox = {
    console,
    window: { PentaTenant: { name: function () { return 'Manna Maids'; } } },
    getUnifiedRoster: function () { return roster; },
    getEmployeeTeam: function (empId, dk) { return teamByEmpDate[empId + '|' + dk] || null; },
    getEmpHours: function (empId, dk) {
      return (overrides[empId] && overrides[empId][dk]) || null;
    },
    _adminEmpDayOff: function (empId, dk) {
      return offDays[empId + '|' + dk] || null;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(helpersSrc, sandbox);
  vm.runInContext(buildReportSrc, sandbox);
  return sandbox;
}

function main() {
  const teams = ['B1', 'S3'];

  // ---- Core Admin/Office behavior: appears once, blank/off/override days ----
  {
    const roster = [
      { id: 'e-linda', name: 'Linda', defaultTeam: null, work_type: 'admin' },
    ];
    const overrides = {
      'e-linda': { '2026-10-06': { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 } }, // Tue -- real entry
      // Mon, Wed, Thu left blank -- no override on file at all
    };
    const offDays = { 'e-linda|2026-10-09': { label: 'Vacation' } }; // Fri -- vacation

    const sandbox = buildSandbox({ roster: roster, overrides: overrides, offDays: offDays });
    const report = sandbox._buildHoursReportFromData(DATES, {}, teams);

    check('Linda is counted once', report.empsSeen, 1);
    check('grand total reflects only her real Tuesday entry (7.5h)', report.grandHours, 7.5);
    check('report text has an ADMIN / OFFICE section header', /ADMIN \/ OFFICE/.test(report.text), true);
    check('Linda\'s own line is labeled (Admin)', /LINDA \(Admin\) — 7h 30m/.test(report.text), true);
    check('her blank Monday shows a dash, not "0:00" or an error', /Mon Oct 5\s+—/.test(report.text), true);
    check('her real Tuesday entry shows the time range', /Tue Oct 6\s+09:00 – 17:00/.test(report.text), true);
    check('her Friday vacation shows the real status, not a blank/zero day', /Fri Oct 9\s+VACATION/.test(report.text), true);

    // CSV: one row per date, Team column says "Admin".
    const csvLines = report.csv.trim().split('\n');
    const lindaLines = csvLines.filter(function (l) { return l.indexOf('Linda') === 0; });
    check('exactly 5 CSV rows for Linda (one per date in range)', lindaLines.length, 5);
    check('every one of Linda\'s CSV rows uses "Admin" as the Team column', lindaLines.every(function (l) { return l.split(',')[1] === 'Admin'; }), true);
    const tuesdayRow = lindaLines.find(function (l) { return l.indexOf('2026-10-06') !== -1; });
    check('Tuesday\'s CSV row carries the real clock-in/out/hours', tuesdayRow, 'Linda,Admin,2026-10-06,09:00,17:00,00:30,07:30');
  }

  // ---- Grand total includes BOTH a field team and Admin/Office ----
  {
    const roster = [
      { id: 'e-alice', name: 'Alice', defaultTeam: 'B1', work_type: 'field' },
      { id: 'e-linda', name: 'Linda', defaultTeam: null, work_type: 'admin' },
    ];
    const teamByEmpDate = { 'e-alice|2026-10-05': 'B1' };
    // ISO strings, not Date instances -- _hrTo24hr constructs its own
    // Date internally via `new Date(d)`, which must happen INSIDE the vm
    // sandbox's own realm. A Date instance built in the outer Node realm
    // fails `instanceof Date` inside the sandbox (each vm.createContext
    // gets its own separate built-ins) and would silently render as "".
    const weekHoursData = { B1: { days: [8, 0, 0, 0, 0], starts: ['2026-10-05T13:00:00Z'], ends: ['2026-10-05T21:00:00Z'], lunch: [null] } };
    const overrides = { 'e-linda': { '2026-10-05': { start: '09:00', end: '13:00', lunch: 0, hours: 4 } } };

    const sandbox = buildSandbox({ roster: roster, teamByEmpDate: teamByEmpDate, overrides: overrides });
    const report = sandbox._buildHoursReportFromData(DATES, weekHoursData, teams);

    check('both Alice and Linda are counted', report.empsSeen, 2);
    check('grand total combines the field team\'s GPS hours and Admin\'s manual hours (8 + 4 = 12)', report.grandHours, 12);
  }

  // ---- PR #180/#186 fragmentation fix still works alongside Admin/Office ----
  {
    // Katia-style case: a field employee whose default team is B1 but who
    // worked S3 on one day that week. Must appear ONCE with a combined total.
    const roster = [
      { id: 'e-katia', name: 'Katia', defaultTeam: 'B1', work_type: 'field' },
      { id: 'e-linda', name: 'Linda', defaultTeam: null, work_type: 'admin' },
    ];
    const teamByEmpDate = {
      'e-katia|2026-10-05': 'B1',
      'e-katia|2026-10-06': 'S3', // cross-team day
    };
    const weekHoursData = {
      B1: { days: [8, 0, 0, 0, 0], starts: ['2026-10-05T13:00:00Z'], ends: ['2026-10-05T21:00:00Z'], lunch: [null] },
      S3: { days: [0, 6, 0, 0, 0], starts: [null, '2026-10-06T13:00:00Z'], ends: [null, '2026-10-06T19:00:00Z'], lunch: [null, null] },
    };
    const overrides = { 'e-linda': { '2026-10-07': { start: '09:00', end: '15:00', lunch: 0, hours: 6 } } };

    const sandbox = buildSandbox({ roster: roster, teamByEmpDate: teamByEmpDate, overrides: overrides });
    const report = sandbox._buildHoursReportFromData(DATES, weekHoursData, teams);

    check('Katia (cross-team week) is still counted exactly once', report.empsSeen, 2);
    check('Katia\'s combined weekly total is 14h (8 on B1 + 6 on S3), not split into two partial entries', /KATIA \(B1\) — 14h 0m/.test(report.text), true);
    check('her Tuesday row is tagged with the real day-of team [S3]', /Tue Oct 6.*\[S3\]/.test(report.text), true);
    check('grand total includes Katia\'s 14h plus Linda\'s 6h (20h total)', report.grandHours, 20);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
