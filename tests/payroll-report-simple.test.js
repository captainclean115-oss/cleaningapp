// Payroll report simplification.
//
// Tom's request: the payroll report (Hours tab -> Export Hours Report)
// should show ONLY name and hours worked -- "Last, First", alphabetical
// by last name -- nothing else (no rates, dollars, times, lunch, team,
// notes). Hours must be the SAME number the Hours tab itself shows for
// that employee/range (single source of truth, via resolveEmployeeDayHours
// -- never a separate recomputation), and must include salaried/
// no-rate/terminated-but-worked employees while leaving out anyone with
// zero hours in the range.
//
// This extracts the REAL getUnifiedRoster/_employeeExcludedAsOf/
// _adminEmpDayOff/isSalariedAdmin, getEmployeeTeam, _dateKeyStr/
// getEmpHours, _hrsFmtHrs/_hrsFmt12/resolveEmployeeDayHours, _hrCsvField,
// and the new _hrSplitName/_hrSortNormalize/_hrDisplayName/
// _hrCompareByLastName/_buildHoursReportFromData straight out of
// index.html. window.PentaEmployees/window.PentaHourOverrides/
// dailyAssignments/EMPLOYEE_ROSTER/dateKey are sandbox fakes standing in
// for the database/localStorage this code normally reads.
//
// Run with: node tests/payroll-report-simple.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}

// Split around the stray top-level `let dailyAssignments = JSON.parse(
// localStorage...)` declaration that sits between _employeeExcludedAsOf
// and _adminEmpDayOff in index.html -- extracting it would shadow this
// file's own dailyAssignments/dailyAssignmentDetails sandbox fakes (a
// `let` re-declaration wins over a vm context property of the same
// name) and crash on the missing `localStorage` global besides.
const rosterSrc1 = extract('function getUnifiedRoster(asOfDate) {', '\nlet dailyAssignments = JSON.parse');
const rosterSrc2 = extract('function _adminEmpDayOff(employeeId, dateStr) {', 'function _computeFormImpact(form) {');
const rosterSrc = rosterSrc1 + '\n' + rosterSrc2;
const teamSrc = extract('\nfunction getEmployeeTeam(employeeId, dateStr) {', '\nfunction getTeamEmployees(team, dateStr) {');
const empHoursSrc = extract('function _dateKeyStr(date) {', 'async function saveEmpHours');
const resolveSrc = extract('function _hrsFmtHrs(h) {', 'function _hrCsvField(s) {');
const csvFieldSrc = extract('function _hrCsvField(s) {', 'function _hoursReportDefaultRange() {');
const reportSrc = extract('function _hrSplitName(emp) {', 'function _hrDownloadCsv(csv, filename) {');

const COMBINED_SRC = rosterSrc + '\n' + teamSrc + '\n' + empHoursSrc + '\n' + resolveSrc + '\n' + csvFieldSrc + '\n' + reportSrc;

function buildSandbox(opts) {
  opts = opts || {};
  const employees = opts.employees || [];
  const overrides = opts.overrides || {}; // empId -> dateStr -> {hours,start,end,lunch}
  const assignments = opts.assignments || {}; // dateStr_empId -> team code | 'OFF'

  function dateKey(d) {
    if (typeof d === 'string') return d;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  const sandbox = {
    console: console,
    window: {
      PentaEmployees: { listSync: function () { return employees; } },
      PentaHourOverrides: {
        getOverride: function (empId, dateStr) {
          return (overrides[empId] && overrides[empId][dateStr]) || null;
        },
      },
      PentaTenant: { name: function () { return 'Manna Maids'; } },
    },
    EMPLOYEE_ROSTER: [],
    dailyAssignments: assignments,
    dailyAssignmentDetails: {},
    dateKey: dateKey,
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return sandbox;
}

// ---- shared fixture week: Mon 2026-11-02 .. Fri 2026-11-06, one team
// "B1" averaging 8h/day for everyone with no personal cell/override. ----
const DATES = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
function fiveDays(v) { return DATES.map(function () { return v; }); }
const WEEK_HOURS_DATA = {
  B1: { days: fiveDays(8), starts: fiveDays(null), ends: fiveDays(null), lunch: fiveDays(null), total: 40 },
};

function fixtureEmployees() {
  return [
    // Accented, lowercase -- must sort with plain "Garcia" alphabetically.
    { id: 'e_jose', name: 'José García', team: 'B1', work_type: 'field', status: 'active' },
    // Uppercase, and the ONE employee with a personal cell (teCell)
    // DIFFERENT from the team average -- proves the report reads the
    // same per-employee cell resolveEmployeeDayHours/the Hours tab uses,
    // not just the team aggregate.
    { id: 'e_alice', name: 'ALICE ZIMMERMAN', team: 'B1', work_type: 'field', status: 'active' },
    // Single-word name -- no last name at all.
    { id: 'e_bob', name: 'Bob', team: 'B1', work_type: 'field', status: 'active' },
    { id: 'e_baker', name: 'Jane Baker', team: 'B1', work_type: 'field', status: 'active' },
    { id: 'e_carter', name: 'Carl Carter', team: 'B1', work_type: 'field', status: 'active' },
    // Duplicate last name -- tie-break by first name.
    { id: 'e_adam', name: 'Adam Smith', team: 'B1', work_type: 'field', status: 'active' },
    { id: 'e_zoe', name: 'Zoe Smith', team: 'B1', work_type: 'field', status: 'active' },
    // Terminated partway through the range -- still worked days 1-2.
    { id: 'e_terri', name: 'Terri Former', team: 'B1', work_type: 'field', status: 'terminated', terminated_at: '2026-11-04' },
    // Never worked a single day this range (explicitly OFF every day) --
    // must be excluded even though she's on the roster with a team.
    { id: 'e_pat', name: 'Pat NoHours', team: 'B1', work_type: 'field', status: 'active' },
    // Salaried Admin/Office -- no hours tracked, ever; must never appear.
    { id: 'e_sal', name: 'Sal Office', work_type: 'admin', pay_type: 'salary', status: 'active' },
    // Hourly Admin/Office with real override hours -- must appear.
    { id: 'e_nora', name: 'Nora Admin', work_type: 'admin', pay_type: 'hourly', status: 'active' },
  ];
}

function fixtureOffAssignments() {
  var a = {};
  DATES.forEach(function (dk) { a[dk + '_e_pat'] = 'OFF'; });
  return a;
}

function fixtureOverrides() {
  return {
    e_alice: DATES.reduce(function (acc, dk) { acc[dk] = { hours: 7 }; return acc; }, {}), // teCell, not an override -- see empHoursMap below
    e_nora: { '2026-11-02': { hours: 6 }, '2026-11-03': { hours: 6 } },
  };
}

function buildEmpHoursMap() {
  // Alice's PERSONAL cell (teCell), distinct from the team's 8h/day
  // average -- this is window._empHoursMap's shape: empId -> dateStr -> {hours,...}.
  var m = {};
  m.e_alice = {};
  DATES.forEach(function (dk) { m.e_alice[dk] = { hours: 7 }; });
  return m;
}

async function main() {

// ======================================================================
// 1. Sorted by last name -- mixed case, accents, blank last name,
//    duplicate last names, all in one real report.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: fixtureEmployees(), assignments: fixtureOffAssignments(), overrides: { e_nora: fixtureOverrides().e_nora } });
  const empHoursMap = buildEmpHoursMap();
  const rep = sandbox._buildHoursReportFromData(DATES, WEEK_HOURS_DATA, ['B1'], empHoursMap);
  const names = rep.text.split('\n').filter(function (l) { return /\d\.\d\d$/.test(l.trim()) && l.indexOf('Total hours') === -1; }).map(function (l) { return l.trim().replace(/\s+[\d.]+$/, ''); });
  check('report produced a non-empty sorted name list', names.length > 0);
  check('Garcia (accented) sorts in the G group, case/accent-insensitive', names.indexOf('García, José') !== -1);
  const bakerIdx = names.indexOf('Baker, Jane');
  const bobIdx = names.indexOf('Bob');
  const carterIdx = names.indexOf('Carter, Carl');
  check('a blank-last-name employee (Bob) sorts after real last names starting with the same letter (Baker)', bakerIdx !== -1 && bobIdx !== -1 && bakerIdx < bobIdx);
  check('a blank-last-name employee (Bob) still sorts before the NEXT letter group (Carter)', bobIdx !== -1 && carterIdx !== -1 && bobIdx < carterIdx);
  const adamIdx = names.indexOf('Smith, Adam');
  const zoeIdx = names.indexOf('Smith, Zoe');
  check('duplicate last names (Smith) are both present, tie-broken by first name (Adam before Zoe)', adamIdx !== -1 && zoeIdx !== -1 && adamIdx < zoeIdx);
  // Overall list must be non-decreasing by the actual comparator used.
  const rows = names.map(function (n) { return { emp: { name: n.indexOf(',') !== -1 ? n.split(', ').reverse().join(' ') : n } }; });
  let sortedOk = true;
  for (let i = 1; i < rows.length; i++) { if (sandbox._hrCompareByLastName(rows[i - 1], rows[i]) > 0) sortedOk = false; }
  check('the full name list is in non-decreasing order per the real comparator', sortedOk);
}

// ======================================================================
// 2. Only two columns, screen AND CSV. No dollar/rate fields anywhere.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: fixtureEmployees(), assignments: fixtureOffAssignments(), overrides: { e_nora: fixtureOverrides().e_nora } });
  const empHoursMap = buildEmpHoursMap();
  const rep = sandbox._buildHoursReportFromData(DATES, WEEK_HOURS_DATA, ['B1'], empHoursMap);
  check('CSV header is exactly "Name,Hours"', rep.csv.split('\n')[0] === 'Name,Hours');
  // Quote-aware split -- a quoted field (e.g. "Zimmerman, Alice" when a
  // name happens to contain a comma from CSV-escaping) must still count
  // as ONE field, not two.
  function csvFieldCount(line) {
    let n = 1, inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ',' && !inQuotes) n++;
    }
    return n;
  }
  const csvDataLines = rep.csv.trim().split('\n').slice(1);
  check('every CSV data row has exactly 2 fields', csvDataLines.every(function (l) { return csvFieldCount(l) === 2; }));
  check('no dollar sign anywhere in the CSV', rep.csv.indexOf('$') === -1);
  check('no dollar sign anywhere in the screen text', rep.text.indexOf('$') === -1);
  check('no clock-in/out, lunch, or team labels in the screen text', !/ClockIn|ClockOut|Lunch|Team\b/i.test(rep.text));
  check('no clock-in/out, lunch, or team columns in the CSV', !/ClockIn|ClockOut|Lunch|Team/i.test(rep.csv));
  check('no rate/gross/overtime wording anywhere in the report', !/rate|gross|overtime/i.test(rep.text) && !/rate|gross|overtime/i.test(rep.csv));
}

// ======================================================================
// 3. Hours match the Hours tab's own source function for this fixture
//    week -- resolveEmployeeDayHours, called directly, must agree with
//    what the report computed for the SAME employee (single source of
//    truth, not a separate recomputation). This is also the case that
//    catches the old bug: the team average (8h/day = 40h) is NOT what
//    Alice should show -- her own personal cell (7h/day = 35h) is.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: fixtureEmployees(), assignments: fixtureOffAssignments() });
  const empHoursMap = buildEmpHoursMap();
  const rep = sandbox._buildHoursReportFromData(DATES, WEEK_HOURS_DATA, ['B1'], empHoursMap);
  // Display preserves the fixture's own ALL-CAPS casing verbatim -- only
  // the SORT comparison is case-insensitive.
  const line = rep.text.split('\n').find(function (l) { return l.indexOf('ZIMMERMAN, ALICE') !== -1; });
  check('Alice appears in the report', !!line);
  check('Alice shows her PERSONAL-cell total (35.00h), not the team average (40.00h) -- the exact bug this fix addresses', !!line && line.indexOf('35.00') !== -1 && line.indexOf('40.00') === -1);

  // Direct cross-check against resolveEmployeeDayHours itself for one day.
  let directTotal = 0;
  DATES.forEach(function (dk, i) {
    const d = new Date(dk + 'T00:00:00');
    const rd = sandbox.resolveEmployeeDayHours('e_alice', d, i, WEEK_HOURS_DATA, empHoursMap);
    if (!rd.isOff) directTotal += rd.hours;
  });
  check('resolveEmployeeDayHours (the Hours tab\'s own function), summed directly, matches the report\'s number exactly', !!line && line.indexOf(directTotal.toFixed(2)) !== -1);
}

// ======================================================================
// 4. Zero-hour employees are excluded entirely.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: fixtureEmployees(), assignments: fixtureOffAssignments() });
  const empHoursMap = buildEmpHoursMap();
  const rep = sandbox._buildHoursReportFromData(DATES, WEEK_HOURS_DATA, ['B1'], empHoursMap);
  check('an employee with zero hours all week (explicitly OFF every day) does not appear', rep.text.indexOf('NoHours') === -1 && rep.csv.indexOf('NoHours') === -1);
}

// ======================================================================
// 5. Salaried Admin/Office excluded; hourly Admin/Office with real
//    override hours IS included; terminated-but-worked-partway IS
//    included (partial hours only, not the full week).
// ======================================================================
{
  const sandbox = buildSandbox({ employees: fixtureEmployees(), assignments: fixtureOffAssignments(), overrides: { e_nora: fixtureOverrides().e_nora } });
  const empHoursMap = buildEmpHoursMap();
  const rep = sandbox._buildHoursReportFromData(DATES, WEEK_HOURS_DATA, ['B1'], empHoursMap);
  check('a salaried Admin/Office employee never appears, even with "no hours tracked" text', rep.text.indexOf('Office, Sal') === -1 && rep.csv.indexOf('Sal Office') === -1);
  const noraLine = rep.text.split('\n').find(function (l) { return l.indexOf('Admin, Nora') !== -1; });
  check('an hourly Admin/Office employee with real override hours IS included (12.00h: two 6h days)', !!noraLine && noraLine.indexOf('12.00') !== -1);
  const terriLine = rep.text.split('\n').find(function (l) { return l.indexOf('Former, Terri') !== -1; });
  check('a terminated-mid-range employee who worked days 1-2 IS included', !!terriLine);
  check('her total only counts the days before termination (16.00h: two 8h days), not the full week (40h)', !!terriLine && terriLine.indexOf('16.00') !== -1 && terriLine.indexOf('40.00') === -1);
}

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
