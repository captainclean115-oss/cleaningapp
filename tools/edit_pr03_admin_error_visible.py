#!/usr/bin/env python3
"""Payroll report simplification -- no silent failures.

DIAGNOSIS: the simplified rewrite's Admin/Office try/catch only logged
a thrown error to the console -- the OLD report used to push a visible
"ADMIN/OFFICE SECTION FAILED TO LOAD: <message>" line into the text
output so Tom would actually see something was wrong instead of just
getting a report quietly missing every admin/office employee. Restored
as a visible line (never into the CSV -- that stays clean two-column
data), appended after the sorted employee list.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  try {
    var adminEmployees = getUnifiedRoster(dates[0]).filter(function (e) { return e.work_type === 'admin'; });
    adminEmployees.forEach(function (emp) {
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) return;
      var empWeekHours = 0;
      dates.forEach(function (dk) {
        if (_employeeExcludedAsOf(emp, dk)) return;
        if (_adminEmpDayOff(emp.id, dk)) return;
        var override = getEmpHours(emp.id, dk);
        if (!override) return;
        empWeekHours += override.hours || 0;
      });
      if (empWeekHours > 0) rows.push({ emp: emp, hours: empWeekHours });
    });
  } catch (e) {
    console.error('[HoursReport] Admin/Office section failed to build (field employees above are unaffected)', e);
  }"""

NEW = """  var adminSectionError = null;
  try {
    var adminEmployees = getUnifiedRoster(dates[0]).filter(function (e) { return e.work_type === 'admin'; });
    adminEmployees.forEach(function (emp) {
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) return;
      var empWeekHours = 0;
      dates.forEach(function (dk) {
        if (_employeeExcludedAsOf(emp, dk)) return;
        if (_adminEmpDayOff(emp.id, dk)) return;
        var override = getEmpHours(emp.id, dk);
        if (!override) return;
        empWeekHours += override.hours || 0;
      });
      if (empWeekHours > 0) rows.push({ emp: emp, hours: empWeekHours });
    });
  } catch (e) {
    console.error('[HoursReport] Admin/Office section failed to build (field employees above are unaffected)', e);
    adminSectionError = (e && e.message) || String(e);
  }"""

EDITS = [("Payroll report simplification: capture admin-section error for a visible line", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
