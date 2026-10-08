#!/usr/bin/env python3
"""Edit 6/N -- salaried Admin/Office feature.

Export Hours Report's Admin/Office section: a salaried employee gets a
single "no hours tracked" summary line, no day rows, no CSV rows at
all -- not even zeroed ones, since there's nothing day-shaped to
report for them. Still counted in empsSeen (they ARE a real employee
who appeared in the report) but never in grandHours.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "_buildHoursReportFromData Admin/Office section: salaried branch, skip day rows/CSV entirely",
        """      adminEmployees.forEach(function (emp) {
        empsSeen++;
        var empWeekHours = 0;
        var dayRows = [];

        dates.forEach(function (dk) {""",
        """      adminEmployees.forEach(function (emp) {
        empsSeen++;
        // Salaried Admin/Office: no hours cells, no CSV rows at all --
        // there's nothing day-shaped to report for them, so this
        // returns before the day loop even starts rather than
        // producing a run of zeroed rows. Counted in empsSeen (a real
        // employee appeared in this report) but never in grandHours.
        if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
          if (empsSeen > 1) textLines.push(SEP_THIN);
          textLines.push((emp.name || emp.id).toUpperCase() + ' (Admin, Salaried) — no hours tracked');
          return;
        }
        var empWeekHours = 0;
        var dayRows = [];

        dates.forEach(function (dk) {""",
    ),
]

apply_edits(EDITS)
