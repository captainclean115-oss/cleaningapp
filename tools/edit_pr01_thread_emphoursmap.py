#!/usr/bin/env python3
"""Payroll report simplification -- STEP 2C groundwork.

DIAGNOSIS: _buildHoursReportFromData computed each employee's per-day
hours with its OWN inline duplicate of the precedence renderHoursTable
(the Hours tab) actually uses -- and that duplicate skipped the
employee's own per-employee GPS/clock cell (window._empHoursMap),
falling straight to the team's blended aggregate whenever there was no
manual override. resolveEmployeeDayHours is the REAL shared function
(already extracted for exactly this "two computations must never
diverge" reason -- see its own comment) that the Hours tab calls; the
Hours Report never did. Threading empHoursMapData through here is what
lets the next edit call that same shared function instead of
recomputing differently.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  return _buildHoursReportFromData(dates, weekHoursData, teams);
}"""

NEW = """  // Payroll report simplification: only the CURRENT Hours-tab week has
  // a per-employee cell map at all (window._empHoursMap, built by
  // loadWeekHours() on the manager's own device) -- an arbitrary custom
  // range has no equivalent, same as weekHoursData's own fast/slow
  // split above. Passing {} there is a correct no-op: resolveEmployeeDayHours
  // simply has no per-employee cell to prefer and falls back to the
  // team aggregate, identical to this function's old inline behavior
  // for that case.
  var empHoursMapData = isCurrentWeek ? (window._empHoursMap || {}) : {};
  return _buildHoursReportFromData(dates, weekHoursData, teams, empHoursMapData);
}"""

EDITS = [("Payroll report simplification: thread empHoursMapData through _buildHoursReportForDates", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
