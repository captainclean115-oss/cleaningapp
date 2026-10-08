#!/usr/bin/env python3
"""Edit 9/N -- salaried Admin/Office feature.

_writeWeekHoursCache's empCache build: skip salaried admin employees
defensively. The portal's own renderHours() no longer reads this
relay for them at all (it returns early from its own salaried branch
before ever touching localStorage), but this loop iterates the WHOLE
roster unconditionally -- excluding them here too means a stray
pre-existing manual_hour_overrides row for a now-salaried employee
can't leak into this cache either, consistent with "never counts in
hours/payroll totals anywhere."
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "_writeWeekHoursCache: skip salaried admin employees when building empCache",
        """    var empCache = {};
    getUnifiedRoster().forEach(function(emp) {
      days.forEach(function(d, i) {
        var dk = dateKey(d);
        var override = getEmpHours(emp.id, dk);
        if (override) {
          if (!empCache[emp.id]) empCache[emp.id] = {};
          empCache[emp.id][dk] = override;
        }
      });
    });""",
        """    var empCache = {};
    getUnifiedRoster().forEach(function(emp) {
      // Salaried Admin/Office: never counts in hours/payroll totals
      // anywhere, including this manager-session->portal relay cache.
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) return;
      days.forEach(function(d, i) {
        var dk = dateKey(d);
        var override = getEmpHours(emp.id, dk);
        if (override) {
          if (!empCache[emp.id]) empCache[emp.id] = {};
          empCache[emp.id][dk] = override;
        }
      });
    });""",
    ),
]

apply_edits(EDITS)
