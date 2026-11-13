#!/usr/bin/env python3
"""Weekend-hours-assignment-only fix. This file's fixture (Oneida's
Saturday GPS/vehicle hours with no job/assignment) was PR #228's own
"it's real, count it but flag it" example -- Tom's new rule overrides
that conclusion entirely: an unassigned weekend day is zero, full stop,
even with a real scheduled job for the team that day. Updates the
total this fixture now produces (44.50h -> 41.00h, the Saturday
dropping out) and replaces the isUnconfirmed assertions with the new
rule's own behavior (unassigned Saturday = 0; explicitly-assigned
Saturday counts fully, same as a weekday).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import _apply_edits as ae

ae.INDEX_HTML = os.path.join(os.path.dirname(__file__), "..", "tests", "hours-report-matches-hours-tab.test.js")

OLD_DOC = """// Hours-report-match-hours-tab fix, corrected by hours-weekend-days.
//
// BUG (Tom's phone test of PR #226): Export Hours Report showed Oneida
// Rojas with 46h for "last week"; the Hours tab's per-employee view,
// same week, showed 42h.
//
// PR #227 concluded the extra ~4h (from an unscheduled Saturday) was
// incidental vehicle/GPS noise and made the report match the Hours
// tab by EXCLUDING weekends entirely from both. Tom corrected that:
// the team actually worked that Saturday -- real data (Supabase,
// read-only) showed the business owner himself reassigned team M2's
// device for that exact date and marked another employee explicitly
// OFF that same day, both actions taken same-day -- strong evidence
// of real, deliberate Saturday operations, not noise. PR #227's "42 is
// right, weekends don't count" conclusion was wrong.
//
// FIX (hours-weekend-days): getWeekDates is the ONE shared week
// definition everywhere (manager Hours tab, employee portal, Export
// Hours Report) and now returns the full 7 days (Mon-Sun, or Sun-Sat
// for a sunday-start business) -- weekends are shown and counted when
// real, with an "unconfirmed" flag (see resolveEmployeeDayHours) on
// hours that come only from team-average GPS/vehicle activity with no
// job or assignment behind them, so a manager can review rather than
// either silently dropping or silently trusting them. Deeper coverage
// of the unconfirmed marker and real-vs-GPS-only weekend days lives in
// tests/hours-weekend-days.test.js; this file keeps proving the
// original concern -- the report and the Hours tab can never show a
// different total for the same employee/week, because both now derive
// the days AND the per-day/weekly-total formula from the exact same
// shared functions (getWeekDates, resolveEmployeeDayHours,
// _pentaEmployeeWeekHours)."""

NEW_DOC = """// Hours-report-match-hours-tab fix, corrected by
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
// resolveEmployeeDayHours, _pentaEmployeeWeekHours)."""

OLD_SECTION2_COMMENT = """// ======================================================================
// 2. For EACH of 3 employees, the report's total over the FULL 7-day
//    range equals the Hours tab's own total (the SAME shared
//    _pentaEmployeeWeekHours function renderHoursTable calls) --
//    including real weekday hours AND the GPS-only Saturday hours.
//    They must agree exactly -- no more silently-different numbers.
// ======================================================================"""

NEW_SECTION2_COMMENT = """// ======================================================================
// 2. For EACH of 3 employees, the report's total over the FULL 7-day
//    range equals the Hours tab's own total (the SAME shared
//    _pentaEmployeeWeekHours function renderHoursTable calls) --
//    weekday hours count, the unassigned Saturday in this fixture does
//    not (no explicit per-employee assignment exists for it). They
//    must agree exactly -- no more silently-different numbers.
// ======================================================================"""

OLD_SECTION2_CHECK = """  // Oneida specifically: 5+10+8+10+8+3.5+0 = 44.50h -- the REAL total,
  // including the Saturday Tom confirmed was genuine. No more 42-vs-46
  // discrepancy: both surfaces show the SAME 44.50h now.
  check('Oneida\\'s Hours-tab/report total is 44.50h -- includes the real Saturday hours, not just the 5 weekdays', sandbox._pentaEmployeeWeekHours('e_oneida', weekDates7(), WEEK_HOURS_DATA, {}).toFixed(2) === '44.50');
}"""

NEW_SECTION2_CHECK = """  // Oneida specifically: 5+10+8+10+8+0+0 = 41.00h -- her Saturday's
  // 3.5h of team-average GPS/vehicle activity has no explicit
  // per-employee assignment behind it in this fixture, so it does not
  // count under the new rule (unlike PR #228's conclusion).
  check('Oneida\\'s Hours-tab/report total is 41.00h -- the unassigned Saturday does not count', sandbox._pentaEmployeeWeekHours('e_oneida', weekDates7(), WEEK_HOURS_DATA, {}).toFixed(2) === '41.00');
}"""

OLD_SECTION3 = """// ======================================================================
// 3. The Saturday hours are genuinely "unconfirmed" per
//    resolveEmployeeDayHours (GPS/team-average only, no job, no
//    assignment) -- shown and counted (never dropped), but flagged so
//    Tom can review. Her weekdays, backed by real scheduled jobs, are
//    NOT flagged.
// ======================================================================
{
  const sandbox = buildSandbox({ employees: EMPLOYEES, jobs: JOBS });
  const satIdx = 5; // 2026-11-07
  const rdSat = sandbox.resolveEmployeeDayHours('e_oneida', new Date('2026-11-07T00:00:00'), satIdx, WEEK_HOURS_DATA, {});
  check('Saturday hours are counted (3.5h), not dropped', rdSat.hours === 3.5);
  check('Saturday is flagged unconfirmed -- GPS/team-average only, no job or assignment behind it', rdSat.isUnconfirmed === true);

  const monIdx = 0; // 2026-11-02, backed by a real job
  const rdMon = sandbox.resolveEmployeeDayHours('e_oneida', new Date('2026-11-02T00:00:00'), monIdx, WEEK_HOURS_DATA, {});
  check('a weekday backed by a real scheduled job is NOT flagged unconfirmed', rdMon.isUnconfirmed === false);
}"""

NEW_SECTION3 = """// ======================================================================
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
}"""

EDITS = [
    ("Weekend-hours-assignment-only fix: update top-of-file doc comment", OLD_DOC, NEW_DOC),
    ("Weekend-hours-assignment-only fix: update section 2 comment", OLD_SECTION2_COMMENT, NEW_SECTION2_COMMENT),
    ("Weekend-hours-assignment-only fix: Oneida's total is now 41.00h, not 44.50h", OLD_SECTION2_CHECK, NEW_SECTION2_CHECK),
    ("Weekend-hours-assignment-only fix: replace isUnconfirmed assertions with the new rule's behavior", OLD_SECTION3, NEW_SECTION3),
]

if __name__ == "__main__":
    ae.apply_edits(EDITS)
