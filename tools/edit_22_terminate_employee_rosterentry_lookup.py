#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- the other half of the
confirmed production bug fixed in edit_21. terminateEmployee() itself
looks up rosterEntry via a bare getUnifiedRoster() call AFTER it has
already flipped her status to 'terminated' (PentaEmployees.update
updates the in-memory cache synchronously, before this line runs) --
so `rosterEntry` was always undefined by this point for a real
termination, and `if (rosterEntry) await _setEmployeeDefaultTeam(...)`
never actually ran. Fixing _setEmployeeDefaultTeam's own internal
lookup (edit_21) isn't enough on its own -- this caller never even
reaches it.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  // Clear the permanent team slot going forward -- reuses the existing,
  // dual-field-safe (team_text + team_id) unassign path.
  try {
    var rosterEntry = getUnifiedRoster().find(function(e){ return e.uuid === employeeId; });
    if (rosterEntry) await _setEmployeeDefaultTeam(rosterEntry.id, '');
  } catch (e) { console.warn('[terminateEmployee] team clear failed (non-fatal)', e); }"""

NEW = """  // Clear the permanent team slot going forward -- reuses the existing,
  // dual-field-safe (team_text + team_id) unassign path.
  //
  // Terminated-employee date-awareness fix (confirmed live production
  // bug): this lookup runs AFTER the status flip just above has already
  // landed in the in-memory facade cache, so a bare getUnifiedRoster()
  // here always excluded her -- this step has never actually executed
  // for a real termination. Confirmed live: Elvia Tonato (terminated
  // 2026-08-19) still has team_id/team_text = 'B1' in production today.
  // _ROSTER_ALL_HISTORY_ASOF resolves her by id regardless of the
  // status we just set.
  try {
    var rosterEntry = getUnifiedRoster(_ROSTER_ALL_HISTORY_ASOF).find(function(e){ return e.uuid === employeeId; });
    if (rosterEntry) await _setEmployeeDefaultTeam(rosterEntry.id, '');
  } catch (e) { console.warn('[terminateEmployee] team clear failed (non-fatal)', e); }"""

EDITS = [("terminateEmployee: resolve rosterEntry regardless of the status just set", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
