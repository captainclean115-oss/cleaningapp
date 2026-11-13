// Weekend-hours-assignment-only fix, replacing PR #228's "unconfirmed"
// design entirely.
//
// PR #227 excluded weekends entirely from the Hours tab/report/portal/
// payroll. PR #228 corrected that to "show and count weekend hours,
// flagging GPS/vehicle-only ones as unconfirmed." Tom overrode PR
// #228 with a stricter, absolute rule: a weekend day (Saturday/Sunday)
// has hours ONLY when Tom explicitly put the employee on a team (or
// marked them OFF) in Team Assignments for that exact date. A default
// team, a team-average GPS/vehicle blend, or vehicle movement NEVER
// creates weekend hours -- the "M3 car moved, Blanca and Ana got
// hours they didn't work" bug. There is no isUnconfirmed flag anymore;
// an unassigned weekend day is simply zero, the same shape as any
// other day off. A manual override is itself explicit and always
// counts, weekend or not.
//
// Separately, resolveEmployeeDayHours now also guards against a
// terminated employee ever having hours on or after her termination
// date, even when a stale daily_assignments row exists for that date
// (the confirmed root cause of a real bug: a backfilled assignment
// row, created after the fact, resurrected a terminated employee's
// hours because getEmployeeTeam's explicit-assignment branch never
// checked termination at all).
//
// This test extracts the REAL getWeekDates, resolveEmployeeDayHours,
// and the shared _pentaEmployeeWeekHours straight out of index.html
// and covers every scenario Tom asked for: an unassigned weekend day
// with team vehicle movement is zero (the Blanca/Ana shape); an
// explicitly-assigned weekend day counts fully; an employee marked
// OFF on a weekend stays zero; a manual override on a weekend counts;
// a terminated employee gets no hours on/after her termination date
// even with a stale assignment row (the Emilia shape); and for every
// scenario, the Hours tab's own weekly total
// (_pentaEmployeeWeekHours) agrees exactly with a direct
// resolveEmployeeDayHours read, since the report (_buildHoursReportFromData)
// and the Hours tab both call into this exact same function -- proven
// separately in tests/hours-report-matches-hours-tab.test.js. Weekday
// behavior (the default-team fallback) is unchanged and still covered
// by tests/resolve-employee-day-hours-equivalence.test.js.
//
// Run with: node tests/hours-weekend-days.test.js

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

// Hours-week-nav fix: getWeekDates is now followed by the new
// _hoursWeekLabelText helper (not hoursWeekMove directly) -- stop
// right at getWeekDates' own closing brace instead.
const getWeekDatesSrc = extract('function getWeekDates(offset) {', '\n\n// Hours-week-nav fix: the one shared label-text formula');
// resolveEmployeeDayHours + the shared _pentaEmployeeWeekHours together
// (adjacent in index.html).
const resolveAndSharedSrc = extract('function _hrsFmtHrs(h) {', '\n\n// ═══════════════════════════════════════════════════════════════════════\n// Published Hours');

// Default roster: just 'e1', always present (not terminated) unless a
// scenario overrides getUnifiedRoster to test the termination guard.
function buildSandbox(opts) {
  opts = opts || {};
  const jobsArr = opts.jobs || [];
  const assignments = opts.assignments || {};
  const sandbox = {
    console,
    dateKey: function (d) { return typeof d === 'string' ? d : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); },
    getEmployeeTeam: opts.getEmployeeTeam || function () { return null; },
    getEmpHours: opts.getEmpHours || function () { return null; },
    getUnifiedRoster: opts.getUnifiedRoster || function () { return [{ id: 'e1' }, { id: 'blanca' }, { id: 'oneida' }, { id: 'mariana' }, { id: 'ana' }]; },
    _pentaPayWeekStartDay: function () { return opts.payWeekStartDay || 'monday'; },
    jobs: jobsArr,
    dailyAssignments: assignments,
  };
  vm.createContext(sandbox);
  vm.runInContext(getWeekDatesSrc, sandbox);
  vm.runInContext(resolveAndSharedSrc, sandbox);
  return sandbox;
}

async function main() {

const SAT = '2026-11-07'; // a Saturday
const SUN = '2026-11-08'; // a Sunday
const satDate = new Date(SAT + 'T00:00:00');
const sunDate = new Date(SUN + 'T00:00:00');

// ======================================================================
// (a) The Blanca/Ana shape: an unassigned weekend day with real team
//     vehicle/GPS movement (team-average fallback has a non-zero
//     value) gives ZERO hours -- no default team, no GPS, no team
//     average ever creates a weekend hour without an explicit
//     daily_assignments entry for THIS employee on THIS date.
// ======================================================================
{
  const sandbox = buildSandbox({
    getEmployeeTeam: function () { return 'M3'; }, // default team fallback, no explicit assignment either day
    assignments: {}, // nobody explicitly assigned this weekend
  });
  const weekHoursData = { M3: { days: [6, 5], starts: [null, null], ends: [null, null], lunch: [null, null], source: 'geotab' } };
  const rdSat = sandbox.resolveEmployeeDayHours('blanca', satDate, 0, weekHoursData, {});
  const rdSun = sandbox.resolveEmployeeDayHours('blanca', sunDate, 1, weekHoursData, {});
  check('unassigned Saturday with team vehicle movement is zero hours (Blanca/Ana shape)', rdSat.hours === 0 && rdSat.isOff === true);
  check('unassigned Sunday with team vehicle movement is zero hours too', rdSun.hours === 0 && rdSun.isOff === true);

  const weekTotal = sandbox._pentaEmployeeWeekHours('blanca', [satDate, sunDate], weekHoursData, {});
  check('the shared weekly-total function agrees: 0h for the whole weekend', weekTotal === 0);
}

// ======================================================================
// (b) An explicitly-assigned weekend day counts fully -- same value --
//     via a direct resolveEmployeeDayHours read AND the shared weekly
//     total both the Hours tab and the report call into. (publishWeekHours
//     and _computeWeekPayroll's own no-skip behavior for an already-
//     resolved weekend row with hours>0 is proven directly in
//     tests/publish-week-hours.test.js and tests/payroll-cost-tally.test.js --
//     neither function has any day-of-week logic of its own; the rule
//     lives entirely here.)
// ======================================================================
{
  const sandbox = buildSandbox({
    getEmployeeTeam: function () { return 'M2'; },
    assignments: { '2026-11-07_oneida': 'M2' }, // explicit assignment for THIS employee, this date
  });
  const weekHoursData = { M2: { days: [6], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const rd = sandbox.resolveEmployeeDayHours('oneida', satDate, 0, weekHoursData, {});
  check('an explicitly-assigned Saturday counts its hours (6h)', rd.hours === 6 && rd.isOff === false);

  const weekTotal = sandbox._pentaEmployeeWeekHours('oneida', [satDate], weekHoursData, {});
  check('the Hours-tab/report shared total agrees exactly (6h) -- same function, same number', weekTotal === 6);
}

// ======================================================================
// (c) An employee explicitly marked OFF on a weekend stays at zero --
//     an explicit assignment entry exists (OFF counts as explicit),
//     but OFF itself still means no hours, same as any other day.
// ======================================================================
{
  const sandbox = buildSandbox({
    getEmployeeTeam: function (empId, dk) { return dk === SAT ? null : 'M2'; }, // getEmployeeTeam already maps OFF -> null
    assignments: { '2026-11-07_mariana': 'OFF' },
  });
  const weekHoursData = { M2: { days: [6], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const rd = sandbox.resolveEmployeeDayHours('mariana', satDate, 0, weekHoursData, {});
  check('an employee explicitly marked OFF on a weekend stays at zero hours', rd.hours === 0 && rd.isOff === true);
}

// ======================================================================
// (d) A manual override entered for a weekend day counts -- it's
//     itself an explicit action, never blocked by the assignment-only
//     guard even with no daily_assignments entry at all.
// ======================================================================
{
  const sandbox = buildSandbox({
    getEmployeeTeam: function () { return 'M3'; }, // default team fallback only, no explicit assignment
    getEmpHours: function () { return { hours: 5, start: '09:00', end: '14:00', lunch: 0 }; },
    assignments: {},
  });
  const weekHoursData = { M3: { days: [0], starts: [null], ends: [null], lunch: [null], source: 'geotab' } }; // no vehicle activity at all -- the override is the only source
  const rd = sandbox.resolveEmployeeDayHours('ana', satDate, 0, weekHoursData, {});
  check('a manual override on a weekend counts in full (5h), not blocked by the assignment-only guard', rd.hours === 5 && rd.isOff === false && rd.isOverride === true);

  const weekTotal = sandbox._pentaEmployeeWeekHours('ana', [satDate], weekHoursData, {});
  check('the shared weekly total agrees exactly (5h)', weekTotal === 5);
}

// ======================================================================
// (e) The Emilia shape: a terminated employee gets no hours on or
//     after her termination date, even with a stale explicit
//     daily_assignments row for that exact date (the confirmed real
//     bug -- getEmployeeTeam's explicit-assignment branch never
//     checked termination). Covers a WEEKDAY too, since the real bug
//     spanned both.
// ======================================================================
{
  const TERM_DATE = '2026-11-04'; // a Wednesday
  const dayAfterTerm = '2026-11-05'; // a Thursday, the day Tom flagged
  const sandbox = buildSandbox({
    getEmployeeTeam: function () { return 'M2'; }, // stale assignment resolves her onto a team either day
    assignments: { '2026-11-04_emilia': 'M2', '2026-11-05_emilia': 'M2' }, // the stale rows -- explicit, but after termination
    getUnifiedRoster: function (asOfDate) {
      // Same isTerminatedAsOf convention getUnifiedRoster itself uses:
      // excluded ON OR AFTER the termination date.
      return asOfDate >= TERM_DATE ? [] : [{ id: 'emilia' }];
    },
  });
  const weekHoursData = { M2: { days: [7.79, 10.81], starts: [null, null], ends: [null, null], lunch: [null, null], source: 'geotab' } };
  const rdTermDay = sandbox.resolveEmployeeDayHours('emilia', new Date(TERM_DATE + 'T00:00:00'), 0, weekHoursData, {});
  const rdAfter = sandbox.resolveEmployeeDayHours('emilia', new Date(dayAfterTerm + 'T00:00:00'), 1, weekHoursData, {});
  check('no hours on the termination date itself, even with a stale explicit assignment row', rdTermDay.hours === 0 && rdTermDay.isOff === true);
  check('no hours the day after termination either (the exact Emilia bug), even with a stale explicit assignment row', rdAfter.hours === 0 && rdAfter.isOff === true);

  const weekTotal = sandbox._pentaEmployeeWeekHours('emilia', [new Date(TERM_DATE + 'T00:00:00'), new Date(dayAfterTerm + 'T00:00:00')], weekHoursData, {});
  check('the shared weekly total agrees: zero for both days on/after termination', weekTotal === 0);

  // Control: the day BEFORE termination still counts normally -- the
  // guard is date-aware, not a blanket exclusion of the employee.
  const dayBeforeTerm = '2026-11-03'; // a Tuesday
  const rdBefore = sandbox.resolveEmployeeDayHours('emilia', new Date(dayBeforeTerm + 'T00:00:00'), 0, { M2: { days: [8], starts: [null], ends: [null], lunch: [null], source: 'geotab' } }, {});
  check('the day BEFORE termination still counts normally (not a blanket exclusion)', rdBefore.hours === 8 && rdBefore.isOff === false);
}

// ======================================================================
// (f) getWeekDates' Sun/Mon week boundary is correct for BOTH
//     pay-week-start-day settings, on whatever day the suite actually
//     runs (no fixed/mocked clock needed -- these properties hold for
//     any "today").
// ======================================================================
{
  const sandbox = buildSandbox({ payWeekStartDay: 'monday' });
  const thisWeek = sandbox.getWeekDates(0);
  check('monday-start: this week has exactly 7 days', thisWeek.length === 7);
  check('monday-start: day 0 is a Monday', thisWeek[0].getDay() === 1);
  check('monday-start: day 6 is a Sunday', thisWeek[6].getDay() === 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  check('monday-start: "today" falls within this week\'s 7 days', thisWeek[0].getTime() <= today.getTime() && today.getTime() <= thisWeek[6].getTime());

  const lastWeek = sandbox.getWeekDates(-1);
  check('monday-start: last week ends exactly one day before this week starts', (thisWeek[0].getTime() - lastWeek[6].getTime()) === 86400000);
  check('monday-start: last week also has 7 days, starting on a Monday', lastWeek.length === 7 && lastWeek[0].getDay() === 1);
}
{
  const sandbox = buildSandbox({ payWeekStartDay: 'sunday' });
  const thisWeek = sandbox.getWeekDates(0);
  check('sunday-start: this week has exactly 7 days', thisWeek.length === 7);
  check('sunday-start: day 0 is a Sunday', thisWeek[0].getDay() === 0);
  check('sunday-start: day 6 is a Saturday', thisWeek[6].getDay() === 6);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  check('sunday-start: "today" falls within this week\'s 7 days', thisWeek[0].getTime() <= today.getTime() && today.getTime() <= thisWeek[6].getTime());

  const lastWeek = sandbox.getWeekDates(-1);
  check('sunday-start: last week ends exactly one day before this week starts', (thisWeek[0].getTime() - lastWeek[6].getTime()) === 86400000);
  check('sunday-start: last week also has 7 days, starting on a Sunday', lastWeek.length === 7 && lastWeek[0].getDay() === 0);
}

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
