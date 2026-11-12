#!/usr/bin/env python3
"""Hours-report-match-hours-tab fix -- STEP 3 (part 1 of 2).

Extracts the ONE shared "sum this employee's hours across these dates"
function, reused by BOTH renderHoursTable (the Hours tab) and
_buildHoursReportFromData (the Export Hours Report) -- both already
call resolveEmployeeDayHours for the per-day number (since PR #226),
but each had its OWN separate accumulation loop. Collapsing that into
one function means the WEEKLY TOTAL -- not just the per-day formula --
can never silently diverge between the two surfaces again.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  return {
    dayTeam: dayTeam, isOff: false,
    hours: hours, startStr: startStr, endStr: endStr, startDate: startDate, endDate: endDate,
    lunchMin: lunchMin, isOpenShift: isOpenShift, isOverride: !!override
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Published Hours (migrations/115_published_employee_hours.sql)."""

NEW = """  return {
    dayTeam: dayTeam, isOff: false,
    hours: hours, startStr: startStr, endStr: endStr, startDate: startDate, endDate: endDate,
    lunchMin: lunchMin, isOpenShift: isOpenShift, isOverride: !!override
  };
}

// Hours-report-match-hours-tab fix: the ONE shared "weekly total"
// function. Sums resolveEmployeeDayHours across the given dates for
// one employee -- the exact same per-day call and accumulation rule
// (skip only genuinely OFF/unassigned days; everything else counts,
// including an incomplete-looking entry, same as the Hours tab's own
// total always has) that renderHoursTable and _buildHoursReportFromData
// both now call into, instead of each keeping its own copy. `dates` can
// be Date objects or YYYY-MM-DD strings -- resolveEmployeeDayHours
// accepts either via dateKey().
function _pentaEmployeeWeekHours(empId, dates, weekHoursData, empHoursMapData) {
  var total = 0;
  dates.forEach(function (d, i) {
    var rd = resolveEmployeeDayHours(empId, d, i, weekHoursData, empHoursMapData);
    if (!rd.isOff) total += rd.hours;
  });
  return total;
}

// ═══════════════════════════════════════════════════════════════════════
// Published Hours (migrations/115_published_employee_hours.sql)."""

EDITS = [("Hours-report-match-hours-tab fix: shared _pentaEmployeeWeekHours function", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
