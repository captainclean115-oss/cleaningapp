// Hours-report-match-hours-tab fix, corrected by
// weekend-hours-assignment-only.
//
// BUG (Tom's phone test of PR #226): Export Hours Report showed Oneida
// Rojas with 46h for "last week"; the Hours tab's per-employee view,
// same week, showed 42h.
//
// PR #227 excluded weekends entirely from both. PR #228 corrected that
// to "show and count weekend hours, flagged unconfirmed when GPS/
// vehicle-only." Tom overrode PR #228 too: a weekend day only has
// hours when he explicitly put the employee on a team (or OFF) in
// Team Assignments for that exact date -- a real scheduled job for
// the team, or team-average/vehicle GPS activity alone, is NEVER
// enough. No isUnconfirmed flag either -- an unassigned weekend day is
// simply zero, same shape as any other day off.
//
// FIX (weekend-hours-assignment-only): getWeekDates is the ONE shared
// week definition everywhere (manager Hours tab, employee portal,
// Export Hours Report) and returns the full 7 days (Mon-Sun, or
// Sun-Sat for a sunday-start business) -- weekends are SHOWN, but only
// COUNTED when explicitly assigned (see resolveEmployeeDayHours).
// Deeper coverage of the assignment-only rule and the terminated-
// employee guard lives in tests/hours-weekend-days.test.js; this file
// keeps proving the original concern -- the report and the Hours tab
// can never show a different total for the same employee/week,
// because both now derive the days AND the per-day/weekly-total
// formula from the exact same shared functions (getWeekDates,
// resolveEmployeeDayHours, _pentaEmployeeWeekHours).
//
// Run with: node tests/hours-report-matches-hours-tab.test.js

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

// resolveEmployeeDayHours + the shared _pentaEmployeeWeekHours, together
// (they're adjacent in index.html).
const resolveAndSharedSrc = extract('function _hrsFmtHrs(h) {', '\n\n// ═══════════════════════════════════════════════════════════════════════\n// Published Hours');
const csvFieldSrc = extract('function _hrCsvField(s) {', 'function _hoursReportDefaultRange() {');
// _buildHoursReportFromData and its PR #226 dependencies (name split/
// sort/display helpers), in one contiguous block.
const reportSrc = extract('function _hrSplitName(emp) {', '\n\nfunction _hrDownloadCsv(');
// The quick-select, now delegating to getWeekDates (hours-weekend-days fix).
const quickSelectSrc = extract('function _hoursReportQuickSelect(which) {', '\n\nasync function confirmHoursReportExport()');

const COMBINED_SRC = resolveAndSharedSrc + '\n' + csvFieldSrc + '\n' + reportSrc + '\n' + quickSelectSrc;

function buildSandbox(opts) {
  opts = opts || {};
  const employees = opts.employees;
  const overrides = opts.overrides || {};
  const jobsArr = opts.jobs || [];
  const assignments = opts.assignments || {};

  const sandbox = {
    console,
    window: { PentaTenant: { name: function () { return 'Manna Maids'; } } },
    document: {
      getElementById: function (id) {
        if (id === 'hours-report-from') return sandbox._fromEl;
        if (id === 'hours-report-to') return sandbox._toEl;
        return null;
      },
    },
    _fromEl: { value: '' },
    _toEl: { value: '' },
    dateKey: function (d) { return typeof d === 'string' ? d : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); },
    getWeekDates: opts.getWeekDates,
    getUnifiedRoster: function () { return employees; },
    getEmployeeTeam: function (empId, dk) {
      var emp = employees.find(function (e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    getEmpHours: function (empId, dk) { return (overrides[empId] && overrides[empId][dk]) || null; },
    isSalariedAdmin: function () { return false; },
    _employeeExcludedAsOf: function () { return false; },
    _adminEmpDayOff: function () { return null; },
    findEmployeeWithSuggestions: function () { return { matches: [], suggestions: [] }; },
    jobs: jobsArr,
    dailyAssignments: assignments,
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return sandbox;
}

// ---- shared fixture: the real shape -- team M2 worked a full 7-day
// week (every weekday backed by a real scheduled job; Saturday backed
// by GPS/device activity only, no job or assignment -- Tom's corrected
// account of the real case). Team M3 has no weekend activity at all
// (the control -- an M3 employee's total is simply unaffected, not
// because weekends are excluded, but because there's nothing there). ----
const DATES_7 = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']; // Mon..Sun
const WEEK_HOURS_DATA = {
  M2: { days: [5, 10, 8, 10, 8, 3.5, 0], starts: DATES_7.map(function () { return null; }), ends: DATES_7.map(function () { return null; }), lunch: DATES_7.map(function () { return null; }), total: 0 },
  M3: { days: [6, 7, 7, 0, 5, 0, 0], starts: DATES_7.map(function () { return null; }), ends: DATES_7.map(function () { return null; }), lunch: DATES_7.map(function () { return null; }), total: 0 },
};
const JOBS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(function (dk, i) {
  return { id: 'j_m2_' + i, date: dk, team: 'M2', cancelled: false };
}); // M2's weekdays are backed by real scheduled jobs; Saturday 11-07 deliberately has none.
const EMPLOYEES = [
  { id: 'e_oneida', name: 'Oneida Rojas', defaultTeam: 'M2' },
  { id: 'e_katerin', name: 'Katerin Yagut', defaultTeam: 'M2' },
  { id: 'e_mariana', name: 'Mariana Hernandez', defaultTeam: 'M3' },
];
function weekDates7() { return DATES_7.map(function (dk) { return new Date(dk + 'T00:00:00'); }); }

async function main() {

// ======================================================================
// 1. _hoursReportQuickSelect('lastweek') produces the Hours tab's own
//    full 7-day week (via getWeekDates) -- Saturday/Sunday included.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: EMPLOYEES, getWeekDates: function (offset) { check('called with offset -1 for "last week"', offset === -1); return weekDates7(); } });
  sandbox._hoursReportQuickSelect('lastweek');
  check('from/to match getWeekDates\' first/last day exactly -- the full week, not just Mon-Fri', sandbox._fromEl.value === '2026-11-02' && sandbox._toEl.value === '2026-11-08');
}

// ======================================================================
// 2. For EACH of 3 employees, the report's total over the FULL 7-day
//    range equals the Hours tab's own total (the SAME shared
//    _pentaEmployeeWeekHours function renderHoursTable calls) --
//    weekday hours count, the unassigned Saturday in this fixture does
//    not (no explicit per-employee assignment exists for it). They
//    must agree exactly -- no more silently-different numbers.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: EMPLOYEES, jobs: JOBS });
  const rep = sandbox._buildHoursReportFromData(DATES_7, WEEK_HOURS_DATA, ['M2', 'M3'], {});

  EMPLOYEES.forEach(function (emp) {
    const hoursTabTotal = sandbox._pentaEmployeeWeekHours(emp.id, weekDates7(), WEEK_HOURS_DATA, {});
    const line = rep.text.split('\n').find(function (l) { return l.indexOf(emp.name.split(' ')[1] || emp.name) !== -1; });
    const reportTotalStr = hoursTabTotal.toFixed(2);
    check('report total for ' + emp.name + ' (' + reportTotalStr + 'h) matches the Hours tab exactly', !!line && line.indexOf(reportTotalStr) !== -1);
  });

  // Oneida specifically: 5+10+8+10+8+0+0 = 41.00h -- her Saturday's
  // 3.5h of team-average GPS/vehicle activity has no explicit
  // per-employee assignment behind it in this fixture, so it does not
  // count under the new rule (unlike PR #228's conclusion).
  check('Oneida\'s Hours-tab/report total is 41.00h -- the unassigned Saturday does not count', sandbox._pentaEmployeeWeekHours('e_oneida', weekDates7(), WEEK_HOURS_DATA, {}).toFixed(2) === '41.00');
}

// ======================================================================
// 3. Weekend-hours-assignment-only fix: an unassigned Saturday is zero
//    -- even with a real scheduled job for the team that day -- and
//    her weekdays are unaffected. A Saturday WITH an explicit
//    per-employee assignment counts fully, exactly like a weekday.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: EMPLOYEES, jobs: JOBS });
  const satIdx = 5; // 2026-11-07, no explicit assignment in this fixture
  const rdSat = sandbox.resolveEmployeeDayHours('e_oneida', new Date('2026-11-07T00:00:00'), satIdx, WEEK_HOURS_DATA, {});
  check('an unassigned Saturday is zero, even with a real scheduled job for the team that day', rdSat.hours === 0 && rdSat.isOff === true);

  const monIdx = 0; // 2026-11-02, a normal weekday
  const rdMon = sandbox.resolveEmployeeDayHours('e_oneida', new Date('2026-11-02T00:00:00'), monIdx, WEEK_HOURS_DATA, {});
  check('a weekday is unaffected -- still counts its hours normally (5h)', rdMon.hours === 5 && rdMon.isOff === false);
}

{
  const sandbox = buildSandbox({ employees: EMPLOYEES, jobs: JOBS, assignments: { '2026-11-07_e_oneida': 'M2' } });
  const satIdx = 5;
  const rdSat = sandbox.resolveEmployeeDayHours('e_oneida', new Date('2026-11-07T00:00:00'), satIdx, WEEK_HOURS_DATA, {});
  check('an explicitly-assigned Saturday counts its hours fully (3.5h), same as a weekday', rdSat.hours === 3.5 && rdSat.isOff === false);
}

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
