#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- REAL, CONFIRMED production
bug found during this task: _setEmployeeDefaultTeam's own internal
lookup was a bare getUnifiedRoster() call. terminateEmployee() calls
PentaEmployees.update({status:'terminated',...}) FIRST (which updates
the in-memory facade cache synchronously), THEN calls
_setEmployeeDefaultTeam(id, '') to clear her team slot -- by that
second call, she is ALREADY excluded from a bare getUnifiedRoster(),
so `if (!emp) return false;` silently no-ops. The team-clearing step
described in terminateEmployee's own comment ("Clear the permanent
team slot going forward") has never actually executed for a real
termination.

Confirmed live, not just in theory: Elvia Tonato (terminated
2026-08-19) still has team_id/team_text = 'B1' in production today,
read via a read-only query during this task's investigation.

Fix: this function's job is "resolve this specific employee BY ID to
update her record," not "should she appear in a list" -- her current
active/terminated status is irrelevant to that. _ROSTER_ALL_HISTORY_ASOF
makes the lookup succeed regardless of status, exactly like the
Archived section and Claire's terminated-explanation helper already do
for the same reason.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function _setEmployeeDefaultTeam(empId, newTeam) {
  var emp = getUnifiedRoster().find(function(e){ return e.id === empId; });
  if (!emp) return false;"""

NEW = """async function _setEmployeeDefaultTeam(empId, newTeam) {
  // Terminated-employee date-awareness fix (confirmed live production
  // bug, see module comment above this edit): this lookup resolves a
  // specific employee BY ID to update her record -- her current
  // active/terminated status must never make that resolution fail,
  // especially right after terminateEmployee() has just flipped it.
  var emp = getUnifiedRoster(_ROSTER_ALL_HISTORY_ASOF).find(function(e){ return e.id === empId; });
  if (!emp) return false;"""

EDITS = [("_setEmployeeDefaultTeam: resolve by id regardless of current status", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
