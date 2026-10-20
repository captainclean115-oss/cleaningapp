#!/usr/bin/env python3
"""Portal-hours-match-manager fix -- renderHours()'s top-of-function
hydration wait covered PentaAssignments/PentaEmployees but not
PentaHourOverrides (the Supabase-backed source getEmpHours/
_adminEmpDayOff actually read) -- a pre-existing gap affecting the
Admin/Office and Salaried branches specifically (they read getEmpHours
directly, never going through loadWeekHours(), which DOES await this
internally). Not the reported bug itself, but a real "await all
hydration before computing hours" gap found while fixing it -- cheap
and safe to close here too.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  if (window.PentaAssignments && typeof window.PentaAssignments.ready === 'function') {
    try {
      var _rhReadyWaits = [window.PentaAssignments.ready()];
      if (window.PentaEmployees && typeof window.PentaEmployees.ready === 'function') {
        _rhReadyWaits.push(window.PentaEmployees.ready());
      }
      await Promise.all(_rhReadyWaits);
      if (typeof _mirrorPentaAssignmentsToInMemory === 'function') _mirrorPentaAssignmentsToInMemory();
    } catch (e) { console.warn('[portal hours] PentaAssignments/PentaEmployees ready or mirror failed', e); }
  }"""

NEW = """  if (window.PentaAssignments && typeof window.PentaAssignments.ready === 'function') {
    try {
      var _rhReadyWaits = [window.PentaAssignments.ready()];
      if (window.PentaEmployees && typeof window.PentaEmployees.ready === 'function') {
        _rhReadyWaits.push(window.PentaEmployees.ready());
      }
      // Portal-hours-match-manager fix: getEmpHours/_adminEmpDayOff
      // (read directly by the Admin/Office and Salaried branches below,
      // and by resolveEmployeeDayHours for the field-employee branch)
      // are backed by PentaHourOverrides -- awaited internally by
      // loadWeekHours() already, but the Admin/Office and Salaried
      // branches never call that function, so they had no hydration
      // guarantee of their own before this.
      if (window.PentaHourOverrides && typeof window.PentaHourOverrides.ready === 'function') {
        _rhReadyWaits.push(window.PentaHourOverrides.ready());
      }
      await Promise.all(_rhReadyWaits);
      if (typeof _mirrorPentaAssignmentsToInMemory === 'function') _mirrorPentaAssignmentsToInMemory();
    } catch (e) { console.warn('[portal hours] PentaAssignments/PentaEmployees/PentaHourOverrides ready or mirror failed', e); }
  }"""

EDITS = [("renderHours: also await PentaHourOverrides hydration", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
