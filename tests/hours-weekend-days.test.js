// Hours-weekend-days fix.
//
// Tom corrected PR #227's conclusion: last Saturday's hours for team M2
// were real work, not incidental vehicle/GPS noise -- real data
// (Supabase, read-only) showed the business owner himself reassigned
// the team's device for that exact date and marked another employee
// explicitly OFF the same day, both same-day actions, strong evidence
// of deliberate Saturday operations. The Hours tab never showed
// Saturday/Sunday at all (getWeekDates was hardcoded to 5 weekdays),
// so there was never a chance to see or confirm it.
//
// Fix: getWeekDates (the one shared week definition for the manager
// Hours tab, the employee portal, and the Export Hours Report) now
// returns the full 7-day week -- Mon-Sun, or Sun-Sat for a sunday-start
// business. Weekend hours are shown and counted using the SAME rule as
// weekdays (resolveEmployeeDayHours / the shared _pentaEmployeeWeekHours
// total) -- no special weekend logic. A day whose hours come only from
// team-average GPS/vehicle activity, with no scheduled job and no
// explicit assignment behind it, is flagged isUnconfirmed: true --
// still shown and still counted (never dropped), but a manager should
// review it (the Hours tab shows a small warning badge) before fully
// trusting it, same reasoning Tom described.
//
// This test extracts the REAL getWeekDates and resolveEmployeeDayHours
// straight out of index.html and covers the 3 scenarios the task asked
// for: a Saturday backed by a real assignment counts normally in both
// the Hours tab and the report; a GPS-only Saturday is flagged but
// still totals the same in both; and the Sun/Mon week boundary is
// correct for both pay-week-start-day settings.
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

const getWeekDatesSrc = extract('function getWeekDates(offset) {', '\n\nfunction hoursWeekMove(dir) {');
// resolveEmployeeDayHours + the shared _pentaEmployeeWeekHours together
// (adjacent in index.html).
const resolveAndSharedSrc = extract('function _hrsFmtHrs(h) {', '\n\n// ═══════════════════════════════════════════════════════════════════════\n// Published Hours');

function buildSandbox(opts) {
  opts = opts || {};
  const jobsArr = opts.jobs || [];
  const assignments = opts.assignments || {};
  const sandbox = {
    console,
    dateKey: function (d) { return typeof d === 'string' ? d : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); },
    getEmployeeTeam: opts.getEmployeeTeam || function () { return null; },
    getEmpHours: opts.getEmpHours || function () { return null; },
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

// ======================================================================
// 1. A Saturday backed by a real assignment (an explicit
//    daily_assignments-style entry for this employee that day) counts
//    normally -- not flagged unconfirmed -- and totals the SAME in
//    both the "Hours tab" total (_pentaEmployeeWeekHours) and a direct
//    resolveEmployeeDayHours read, since both are the same function.
// ======================================================================
{
  const satDk = '2026-11-07'; // a Saturday
  const sandbox = buildSandbox({
    getEmployeeTeam: function (empId, dk) { return dk === satDk ? 'M2' : null; },
    assignments: { '2026-11-07_e1': 'M2' }, // explicit assignment for THIS employee, this date
  });
  const weekHoursData = { M2: { days: [6], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const satDate = new Date(satDk + 'T00:00:00');
  const rd = sandbox.resolveEmployeeDayHours('e1', satDate, 0, weekHoursData, {});
  check('a Saturday backed by a real assignment counts its hours (6h)', rd.hours === 6);
  check('a Saturday backed by a real assignment is NOT flagged unconfirmed', rd.isUnconfirmed === false);

  const weekTotal = sandbox._pentaEmployeeWeekHours('e1', [satDate], weekHoursData, {});
  check('the shared weekly-total function (what both the Hours tab and the report call) agrees exactly (6h)', weekTotal === 6);
}

// ======================================================================
// 2. A GPS-only Saturday (no job, no assignment -- team-average
//    fallback only) is shown and counted, flagged isUnconfirmed, and
//    still totals the SAME in both surfaces -- never dropped, never
//    silently trusted as "confirmed."
// ======================================================================
{
  const satDk = '2026-11-07';
  const sandbox = buildSandbox({
    getEmployeeTeam: function (empId, dk) { return dk === satDk ? 'M2' : null; }, // falls back to default team, no explicit assignment
    jobs: [], // no scheduled job for M2 that day
    assignments: {}, // no explicit assignment for this employee that day either
  });
  const weekHoursData = { M2: { days: [3.5], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const satDate = new Date(satDk + 'T00:00:00');
  const rd = sandbox.resolveEmployeeDayHours('e1', satDate, 0, weekHoursData, {});
  check('a GPS-only Saturday is shown and counted (3.5h), never silently dropped', rd.hours === 3.5);
  check('a GPS-only Saturday with no job or assignment IS flagged unconfirmed', rd.isUnconfirmed === true);

  const weekTotal = sandbox._pentaEmployeeWeekHours('e1', [satDate], weekHoursData, {});
  check('the shared weekly-total function still counts it (3.5h) -- unconfirmed is a review flag, not an exclusion rule', weekTotal === 3.5);
}

// A scheduled (non-cancelled) job for the team that day is ALSO enough
// to confirm it, independent of any employee-level assignment.
{
  const satDk = '2026-11-07';
  const sandbox = buildSandbox({
    getEmployeeTeam: function (empId, dk) { return dk === satDk ? 'M2' : null; },
    jobs: [{ id: 'j1', date: satDk, team: 'M2', cancelled: false }],
    assignments: {},
  });
  const weekHoursData = { M2: { days: [4], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const rd = sandbox.resolveEmployeeDayHours('e1', new Date(satDk + 'T00:00:00'), 0, weekHoursData, {});
  check('a scheduled job for the team that day confirms it too, even with no employee-level assignment', rd.isUnconfirmed === false);
}

// A CANCELLED job does not count as confirmation.
{
  const satDk = '2026-11-07';
  const sandbox = buildSandbox({
    getEmployeeTeam: function (empId, dk) { return dk === satDk ? 'M2' : null; },
    jobs: [{ id: 'j1', date: satDk, team: 'M2', cancelled: true }],
    assignments: {},
  });
  const weekHoursData = { M2: { days: [4], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const rd = sandbox.resolveEmployeeDayHours('e1', new Date(satDk + 'T00:00:00'), 0, weekHoursData, {});
  check('a CANCELLED job does not confirm the day -- still flagged unconfirmed', rd.isUnconfirmed === true);
}

// A manual override or a personal GPS cell is its own confirmation --
// never flagged, even with no job/assignment at all.
{
  const satDk = '2026-11-07';
  const sandbox = buildSandbox({
    getEmployeeTeam: function (empId, dk) { return dk === satDk ? 'M2' : null; },
    getEmpHours: function () { return { hours: 5, start: '09:00', end: '14:00', lunch: 0 }; },
    jobs: [], assignments: {},
  });
  const weekHoursData = { M2: { days: [3.5], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const rd = sandbox.resolveEmployeeDayHours('e1', new Date(satDk + 'T00:00:00'), 0, weekHoursData, {});
  check('a manual override is its own confirmation -- not flagged unconfirmed even with no job/assignment', rd.isUnconfirmed === false && rd.hours === 5);
}

// A day with zero hours is never flagged (nothing to confirm or review).
{
  const satDk = '2026-11-07';
  const sandbox = buildSandbox({
    getEmployeeTeam: function (empId, dk) { return dk === satDk ? 'M2' : null; },
    jobs: [], assignments: {},
  });
  const weekHoursData = { M2: { days: [0], starts: [null], ends: [null], lunch: [null], source: 'geotab' } };
  const rd = sandbox.resolveEmployeeDayHours('e1', new Date(satDk + 'T00:00:00'), 0, weekHoursData, {});
  check('a zero-hour day is never flagged unconfirmed (nothing to review)', rd.isUnconfirmed === false);
}

// ======================================================================
// 3. getWeekDates' Sun/Mon week boundary is correct for BOTH
//    pay-week-start-day settings, on whatever day the suite actually
//    runs (no fixed/mocked clock needed -- these properties hold for
//    any "today").
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
