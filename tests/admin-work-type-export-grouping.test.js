// Admin/Office employee designation (migration 113) -- Export Hours
// Report (_buildHoursReportFromData), now against the simplified
// Name+Hours output (payroll report simplification).
//
// Covers, against the REAL extracted source:
//   1. An Admin/Office employee with real override hours gets a row,
//      same as a field employee -- one combined report, not two.
//   2. No override on file contributes nothing (never a fabricated
//      "0:00" counted as real hours).
//   3. An explicit OFF/vacation day is excluded from her total, not
//      zeroed-and-counted.
//   4. Admin hours are included in the SAME grandHours/empsSeen totals
//      field employees feed.
//   5. The PR #180/#186 fragmentation fix (a cross-team field employee
//      counted ONCE with a combined weekly total) still works
//      correctly alongside an Admin/Office employee in the same report.
//
// The old per-day CSV rows / "ADMIN / OFFICE" section header / "(Admin)"
// label / per-day dash-or-vacation display this test used to check are
// gone by design (two columns only, Name and Hours) -- updated to check
// the underlying totals/inclusion instead of removed display details.
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

const resolveSrc = extract('function _hrsFmtHrs(h) {', 'function _hrCsvField(s) {', 'resolveEmployeeDayHours');
const csvFieldSrc = extract('function _hrCsvField(s) {', 'function _hoursReportDefaultRange() {', '_hrCsvField');
const buildReportSrc = extract('function _hrSplitName(emp) {', '\n\nfunction _hrDownloadCsv(', '_buildHoursReportFromData');

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
    dateKey: function (d) { return typeof d === 'string' ? d : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); },
    _pentaBusinessTimezone: function () { return 'America/New_York'; },
    getUnifiedRoster: function () { return roster; },
    getEmployeeTeam: function (empId, dk) { return teamByEmpDate[empId + '|' + dk] || null; },
    getEmpHours: function (empId, dk) {
      return (overrides[empId] && overrides[empId][dk]) || null;
    },
    _adminEmpDayOff: function (empId, dk) {
      return offDays[empId + '|' + dk] || null;
    },
    isSalariedAdmin: function () { return false; },
    _employeeExcludedAsOf: function (emp, dateStr) {
      return !!(emp && emp.status === 'terminated' && emp.terminated_at && dateStr >= emp.terminated_at);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(resolveSrc, sandbox);
  vm.runInContext(csvFieldSrc, sandbox);
  vm.runInContext(buildReportSrc, sandbox);
  return sandbox;
}

function main() {
  const teams = ['B1', 'S3'];

  // ---- Core Admin/Office behavior: one row, only her REAL hours count ----
  {
    const roster = [
      { id: 'e-linda', name: 'Linda', defaultTeam: null, work_type: 'admin' },
    ];
    const overrides = {
      'e-linda': { '2026-10-06': { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 } }, // Tue -- real entry
      // Mon, Wed, Thu left blank -- no override on file at all
    };
    const offDays = { 'e-linda|2026-10-09': { label: 'Vacation' } }; // Fri -- vacation, must not count

    const sandbox = buildSandbox({ roster: roster, overrides: overrides, offDays: offDays });
    const report = sandbox._buildHoursReportFromData(DATES, {}, teams, {});

    check('Linda is counted once', report.empsSeen, 1);
    check('grand total reflects only her real Tuesday entry (7.5h), blank/vacation days contribute nothing', report.grandHours, 7.5);
    check('she appears in the report at 7.50h', report.text.indexOf('7.50') !== -1, true);
    check('the CSV has exactly one row for her', report.csv.trim().split('\n').slice(1).length, 1);
    check('that CSV row is just Name,Hours', report.csv.trim().split('\n')[1], 'Linda,7.50');
  }

  // ---- Grand total includes BOTH a field team and Admin/Office ----
  {
    const roster = [
      { id: 'e-alice', name: 'Alice', defaultTeam: 'B1', work_type: 'field' },
      { id: 'e-linda', name: 'Linda', defaultTeam: null, work_type: 'admin' },
    ];
    const teamByEmpDate = { 'e-alice|2026-10-05': 'B1' };
    const weekHoursData = { B1: { days: [8, 0, 0, 0, 0], starts: ['2026-10-05T13:00:00Z'], ends: ['2026-10-05T21:00:00Z'], lunch: [null] } };
    const overrides = { 'e-linda': { '2026-10-05': { start: '09:00', end: '13:00', lunch: 0, hours: 4 } } };

    const sandbox = buildSandbox({ roster: roster, teamByEmpDate: teamByEmpDate, overrides: overrides });
    const report = sandbox._buildHoursReportFromData(DATES, weekHoursData, teams, {});

    check('both Alice and Linda are counted', report.empsSeen, 2);
    check('grand total combines the field team\'s GPS hours and Admin\'s manual hours (8 + 4 = 12)', report.grandHours, 12);
    check('Alice shows 8.00h', report.text.indexOf('8.00') !== -1, true);
    check('Linda shows 4.00h', report.text.indexOf('4.00') !== -1, true);
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
    const report = sandbox._buildHoursReportFromData(DATES, weekHoursData, teams, {});

    check('Katia (cross-team week) is still counted exactly once, not fragmented into two entries', report.empsSeen, 2);
    check('Katia\'s combined weekly total is 14h (8 on B1 + 6 on S3)', report.text.indexOf('14.00') !== -1, true);
    check('grand total includes Katia\'s 14h plus Linda\'s 6h (20h total)', report.grandHours, 20);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
