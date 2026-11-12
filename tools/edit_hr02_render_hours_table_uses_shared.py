#!/usr/bin/env python3
"""Hours-report-match-hours-tab fix -- STEP 3 (part 2). renderHoursTable
now computes empWeekTotal via the shared _pentaEmployeeWeekHours
function up front, instead of accumulating it inline inside the per-day
cell-building loop (which still runs unchanged for the cells
themselves -- this only removes the now-redundant += that would
otherwise double it).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """    const empRowsHtml = teamEmployees.map(emp => {
      const empMap = empHoursMap[emp.id] || {};
      let empWeekTotal = 0;
      let empHasOpenShift = false;"""

NEW1 = """    const empRowsHtml = teamEmployees.map(emp => {
      const empMap = empHoursMap[emp.id] || {};
      // Hours-report-match-hours-tab fix: the ONE shared weekly-total
      // function, also used by _buildHoursReportFromData -- computed up
      // front so the cell-building loop below never has to re-derive it.
      let empWeekTotal = _pentaEmployeeWeekHours(emp.id, days, weekHours, empHoursMap);
      let empHasOpenShift = false;"""

OLD2 = """        const empH = _rd.hours;
        empWeekTotal += empH;
        const isOpen = _rd.isOpenShift;"""

NEW2 = """        const empH = _rd.hours;
        const isOpen = _rd.isOpenShift;"""

EDITS = [
    ("Hours-report-match-hours-tab fix: renderHoursTable computes empWeekTotal via the shared function", OLD1, NEW1),
    ("Hours-report-match-hours-tab fix: remove the now-redundant inline += (would double-count)", OLD2, NEW2),
]

if __name__ == "__main__":
    apply_edits(EDITS)
