// Hours-report-match-hours-tab fix.
//
// BUG (Tom's phone test of PR #226): Export Hours Report showed Oneida
// Rojas with 46h for "last week"; the Hours tab's per-employee view,
// same week, showed 42h.
//
// ROOT CAUSE (confirmed against real Supabase data, read-only, Manna
// Maids business_id 48532f06-0625-415b-9091-2638bed6506d): the report's
// "This week"/"Last week" quick-selects computed a full Mon-Sun 7-day
// span (_computeLastPayWeekRange), while the Hours tab's per-employee
// view (getWeekDates) only EVER looks at 5 weekdays (Mon-Fri) for any
// week, for every business -- it never asks about Saturday/Sunday at
// all. Manna Maids has essentially zero weekend operations (zero
// scheduled jobs, either team, for the real Sat/Sun in question), but
// team M2 had an unscheduled, date-scoped device reassignment on that
// exact Saturday (team_device_assignments) with no matching job,
// employee assignment, or override behind it -- the report's wider
// range picked up whatever incidental GPS activity that produced and
// attributed it, via the team-average fallback, to every M2-default
// employee that week (confirmed: Oneida AND Katerin Yagut, both
// M2-default, would show the identical inflated total; Mariana
// Hernandez, M3-default and explicitly marked OFF that Saturday, would
// not). 42h was Oneida's correct total; 46h was inflated by a day
// nobody was scheduled to work.
//
// FIX: (1) _hoursReportQuickSelect now delegates to getWeekDates (the
// Hours tab's own week-definition function) for "This week"/"Last
// week," instead of a separately-computed 7-day span. (2) Both
// renderHoursTable and _buildHoursReportFromData now call ONE shared
// function, _pentaEmployeeWeekHours, for an employee's weekly total,
// instead of each keeping its own copy -- they already called the same
// resolveEmployeeDayHours per day (PR #226), but not the same
// accumulation.
//
// This test extracts the REAL resolveEmployeeDayHours, the new shared
// _pentaEmployeeWeekHours, _buildHoursReportFromData (and its
// dependencies from PR #226 -- _hrSplitName/_hrCompareByLastName/
// _hrResolvedSummary/etc.), and _hoursReportQuickSelect straight out of
// index.html, and proves report totals equal "Hours tab" totals
// (computed via the SAME shared function, same as renderHoursTable
// would) for 3 employees, including the Oneida-shaped case -- plus
// demonstrates the OLD 7-day range would NOT have matched, so this
// test can't pass by coincidence.
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

// resolveEmployeeDayHours + the new shared _pentaEmployeeWeekHours,
// together (they're adjacent in index.html).
const resolveAndSharedSrc = extract('function _hrsFmtHrs(h) {', '\n\n// ═══════════════════════════════════════════════════════════════════════\n// Published Hours');
const csvFieldSrc = extract('function _hrCsvField(s) {', 'function _hoursReportDefaultRange() {');
// _buildHoursReportFromData and its PR #226 dependencies (name split/
// sort/display helpers), in one contiguous block.
const reportSrc = extract('function _hrSplitName(emp) {', '\n\nfunction _hrDownloadCsv(');
// The fixed quick-select.
const quickSelectSrc = extract('function _hoursReportQuickSelect(which) {', '\n\nasync function confirmHoursReportExport()');

const COMBINED_SRC = resolveAndSharedSrc + '\n' + csvFieldSrc + '\n' + reportSrc + '\n' + quickSelectSrc;

function buildSandbox(opts) {
  opts = opts || {};
  const employees = opts.employees; // [{id,name,defaultTeam}]
  const overrides = opts.overrides || {};

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
    getWeekDates: opts.getWeekDates, // real per-test fixture, see below
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
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return sandbox;
}

// ---- shared fixture: team M2 has an unscheduled Saturday GPS/device
// blip (3.5h, days[5]) that nobody was actually scheduled to work --
// exactly Oneida's real shape. Team M3 has no weekend activity at all
// (the control -- an M3 employee must NOT be affected). ----
const DATES_7 = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']; // Mon..Sun
const DATES_5 = DATES_7.slice(0, 5); // Mon..Fri -- what getWeekDates/the Hours tab actually shows
function fiveAndTwo(five, weekend) { return five.concat(weekend); }
const WEEK_HOURS_DATA = {
  M2: { days: fiveAndTwo([5, 10, 8, 10, 8], [3.5, 0]), starts: DATES_7.map(function () { return null; }), ends: DATES_7.map(function () { return null; }), lunch: DATES_7.map(function () { return null; }), total: 0 },
  M3: { days: fiveAndTwo([6, 7, 7, 0, 5], [0, 0]), starts: DATES_7.map(function () { return null; }), ends: DATES_7.map(function () { return null; }), lunch: DATES_7.map(function () { return null; }), total: 0 },
};
const EMPLOYEES = [
  { id: 'e_oneida', name: 'Oneida Rojas', defaultTeam: 'M2' },
  { id: 'e_katerin', name: 'Katerin Yagut', defaultTeam: 'M2' },
  { id: 'e_mariana', name: 'Mariana Hernandez', defaultTeam: 'M3' },
];
function weekDates5() { return DATES_5.map(function (dk) { return new Date(dk + 'T00:00:00'); }); }
function weekDates7() { return DATES_7.map(function (dk) { return new Date(dk + 'T00:00:00'); }); }

async function main() {

// ======================================================================
// 1. _hoursReportQuickSelect('lastweek') now produces the Hours tab's
//    OWN 5 weekdays (via getWeekDates), never the old 7-day span.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: EMPLOYEES, getWeekDates: function (offset) { check('called with offset -1 for "last week"', offset === -1); return weekDates5(); } });
  sandbox._hoursReportQuickSelect('lastweek');
  check('from/to match getWeekDates\' first/last weekday exactly', sandbox._fromEl.value === '2026-11-02' && sandbox._toEl.value === '2026-11-06');
}

// ======================================================================
// 2. For EACH of 3 employees (including Oneida's exact shape), the
//    report's total over the FIXED 5-day range equals the Hours tab's
//    own total (computed via the SAME shared _pentaEmployeeWeekHours
//    function renderHoursTable calls) -- they must agree exactly.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: EMPLOYEES });
  const rep = sandbox._buildHoursReportFromData(DATES_5, WEEK_HOURS_DATA, ['M2', 'M3'], {});

  EMPLOYEES.forEach(function (emp) {
    const hoursTabTotal = sandbox._pentaEmployeeWeekHours(emp.id, weekDates5(), WEEK_HOURS_DATA, {});
    const line = rep.text.split('\n').find(function (l) { return l.indexOf(emp.name.split(' ')[1] || emp.name) !== -1 || l.indexOf(emp.name) !== -1; });
    const reportTotalStr = hoursTabTotal.toFixed(2);
    check('report total for ' + emp.name + ' (' + reportTotalStr + 'h) matches the Hours tab exactly', !!line && line.indexOf(reportTotalStr) !== -1);
  });

  // Oneida specifically: 5+10+8+10+8 = 41.00h -- the exact bug-report shape.
  check('Oneida\'s Hours-tab/report total is 41.00h (the real 5-weekday sum, no weekend)', sandbox._pentaEmployeeWeekHours('e_oneida', weekDates5(), WEEK_HOURS_DATA, {}).toFixed(2) === '41.00');
}

// ======================================================================
// 3. Proof this isn't a coincidence: the OLD 7-day range (what the
//    quick-select used to produce) WOULD have shown a different,
//    inflated number for the M2 employees (not Mariana, M3) -- exactly
//    reproducing the reported 46-vs-42-shaped gap, and confirming it's
//    NOT only Oneida (Katerin, same team, same shape; Mariana, a
//    different team with no weekend activity, is correctly unaffected).
// ======================================================================
{
  const sandbox = buildSandbox({ employees: EMPLOYEES });
  const repOld7Day = sandbox._buildHoursReportFromData(DATES_7, WEEK_HOURS_DATA, ['M2', 'M3'], {});
  const hoursTabTotal = sandbox._pentaEmployeeWeekHours('e_oneida', weekDates5(), WEEK_HOURS_DATA, {});

  const oneidaOldLine = repOld7Day.text.split('\n').find(function (l) { return l.indexOf('Oneida') !== -1; });
  check('the OLD 7-day range DID inflate Oneida\'s total above the Hours tab\'s (44.50h vs 41.00h) -- confirms this is the real mechanism, not a coincidence', !!oneidaOldLine && oneidaOldLine.indexOf('44.50') !== -1 && oneidaOldLine.indexOf(hoursTabTotal.toFixed(2)) === -1);

  const katerinOldLine = repOld7Day.text.split('\n').find(function (l) { return l.indexOf('Katerin') !== -1; });
  check('Katerin (same team, same week) is affected the same way -- not just Oneida', !!katerinOldLine && katerinOldLine.indexOf('44.50') !== -1);

  const marianaOldLine = repOld7Day.text.split('\n').find(function (l) { return l.indexOf('Mariana') !== -1; });
  const marianaHoursTab = sandbox._pentaEmployeeWeekHours('e_mariana', weekDates5(), WEEK_HOURS_DATA, {});
  check('Mariana (different team, no weekend activity) is correctly UNaffected even by the old 7-day range', !!marianaOldLine && marianaOldLine.indexOf(marianaHoursTab.toFixed(2)) !== -1);
}

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
