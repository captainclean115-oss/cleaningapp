#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- Export Hours Report
Admin/Office per-day guard, mirroring edit_02's Hours-table fix.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "Export Report admin day loop: blank days on/after exclusion date",
        """        dates.forEach(function (dk) {
          var d = new Date(dk + 'T00:00:00');
          var dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          var offInfo = _adminEmpDayOff(emp.id, dk);
          if (offInfo) {""",
        """        dates.forEach(function (dk) {
          var d = new Date(dk + 'T00:00:00');
          var dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          // Terminated-employee date-awareness fix: same reasoning as
          // the Hours table's admin branch -- manual_hour_overrides has
          // no built-in cutoff at termination, so force-blank any day
          // on/after her exclusion date explicitly.
          if (_employeeExcludedAsOf(emp, dk)) {
            dayRows.push('  ' + dayLabel.padEnd(14) + '—');
            csvRows.push([_hrCsvField(emp.name || emp.id), 'Admin', dk, '', '', '', '0:00'].join(','));
            return;
          }
          var offInfo = _adminEmpDayOff(emp.id, dk);
          if (offInfo) {""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
