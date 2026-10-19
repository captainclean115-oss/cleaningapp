#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- showEmpDayDetail/
saveEmpDayHours's defense-in-depth salaried-admin lookups were bare
getUnifiedRoster() calls, so a terminated salaried admin's PAST day
(before her termination) would silently fail this lookup (she's
excluded from a bare call regardless of date) and fall through as if
she weren't salaried at all. Both functions already have the relevant
date (dk) in scope -- pass it through.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "showEmpDayDetail: date-aware salaried-admin lookup",
        """  try {
    var _sedEmp = getUnifiedRoster().find(function(e) { return e.id === empId; });
    if (_sedEmp && typeof isSalariedAdmin === 'function' && isSalariedAdmin(_sedEmp)) {
      alert(_sedEmp.name + ' is salaried -- there are no hours to enter.');
      return;
    }
  } catch (e) { console.warn('[showEmpDayDetail] salaried-admin check failed (non-fatal, continuing to open)', e); }
  localStorage.removeItem('_empLunchStop');
  var date = new Date(dateMs);
  var dk = dateKey(date);""",
        """  localStorage.removeItem('_empLunchStop');
  var date = new Date(dateMs);
  var dk = dateKey(date);
  // Terminated-employee date-awareness fix: dk (this day's date) is now
  // computed before this check, and passed to getUnifiedRoster -- a
  // bare call used to exclude a terminated salaried admin regardless of
  // which day was clicked, silently skipping this guard for any day
  // before her termination too.
  try {
    var _sedEmp = getUnifiedRoster(dk).find(function(e) { return e.id === empId; });
    if (_sedEmp && typeof isSalariedAdmin === 'function' && isSalariedAdmin(_sedEmp)) {
      alert(_sedEmp.name + ' is salaried -- there are no hours to enter.');
      return;
    }
  } catch (e) { console.warn('[showEmpDayDetail] salaried-admin check failed (non-fatal, continuing to open)', e); }""",
    ),
    (
        "saveEmpDayHours: date-aware salaried-admin lookup",
        """  try {
    var _sehEmp = getUnifiedRoster().find(function(e) { return e.id === empId; });
    if (_sehEmp && typeof isSalariedAdmin === 'function' && isSalariedAdmin(_sehEmp)) {
      alert(_sehEmp.name + ' is salaried, so there are no hours to save. Nothing was changed.');
      return;
    }
  } catch (e) { console.warn('[saveEmpDayHours] salaried-admin check failed (non-fatal, continuing to save)', e); }""",
        """  try {
    // Terminated-employee date-awareness fix: dk (this function's own
    // parameter) passed to getUnifiedRoster -- a bare call used to
    // exclude a terminated salaried admin regardless of which day was
    // being saved.
    var _sehEmp = getUnifiedRoster(dk).find(function(e) { return e.id === empId; });
    if (_sehEmp && typeof isSalariedAdmin === 'function' && isSalariedAdmin(_sehEmp)) {
      alert(_sehEmp.name + ' is salaried, so there are no hours to save. Nothing was changed.');
      return;
    }
  } catch (e) { console.warn('[saveEmpDayHours] salaried-admin check failed (non-fatal, continuing to save)', e); }""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
