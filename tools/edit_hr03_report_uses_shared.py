#!/usr/bin/env python3
"""Hours-report-match-hours-tab fix -- STEP 3 (part 3). The report's
field-employee loop now calls the SAME shared _pentaEmployeeWeekHours
function renderHoursTable uses, instead of its own separate dates.forEach
accumulation (which happened to apply the identical rule already, but
as a second copy that could silently drift from the Hours tab's on a
future edit to either one).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  fieldEmployees.forEach(function (emp) {
    var empWeekHours = 0;
    dates.forEach(function (dk, dayIdx) {
      var d = new Date(dk + 'T00:00:00');
      var rd = resolveEmployeeDayHours(emp.id, d, dayIdx, weekHoursData, empHoursMapData);
      if (!rd.isOff) empWeekHours += rd.hours;
    });
    if (empWeekHours > 0) rows.push({ emp: emp, hours: empWeekHours });
  });"""

NEW = """  var dateObjs = dates.map(function (dk) { return new Date(dk + 'T00:00:00'); });
  fieldEmployees.forEach(function (emp) {
    var empWeekHours = _pentaEmployeeWeekHours(emp.id, dateObjs, weekHoursData, empHoursMapData);
    if (empWeekHours > 0) rows.push({ emp: emp, hours: empWeekHours });
  });"""

EDITS = [("Hours-report-match-hours-tab fix: report's field-employee total via the shared function", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
