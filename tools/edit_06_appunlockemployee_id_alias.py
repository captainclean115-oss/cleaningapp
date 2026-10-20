#!/usr/bin/env python3
"""Portal-hours-match-manager fix -- REAL, CONFIRMED bug: a real
employee login (_bootResolveEmployeeFromAuth) already aliases
emp.id = legacy_roster_id || uuid (and keeps emp.uuid = the real
Supabase id) -- but several "Preview as employee" entry points pass a
raw facade row (getStaffList()/PentaEmployees.listSync(), via
_fromRow) straight into appUnlockEmployee instead. _fromRow's own .id
is the raw Supabase uuid, NOT aliased -- legacy_roster_id is a
separate field on that row. Every hours-reading function in this file
(getEmpHours, getEmployeeTeam, dailyAssignments) keys by
legacy_roster_id when one exists.

Confirmed live via a read-only query: ALL 25 currently-active
employees have a legacy_roster_id that differs from their id. Preview
via the Staff-detail eye-icon button (getStaffList()[idx], unaliased)
would look up every one of their hours under the WRONG key, showing
blank/wrong data -- while the SAME employee's real login, and the
manager's own Hours table, correctly use legacy_roster_id. This is the
Preview-vs-real-login divergence the task asked to check for.

Fixed once, at the single shared chokepoint every entry point (real
login AND every Preview path) already funnels through --
appUnlockEmployee itself -- rather than patching each call site
separately. Safe for the already-correctly-aliased real-login case
too: when emp.id already equals legacy_roster_id, the condition below
is false and nothing changes.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function appUnlockEmployee(emp) {
  // Bug 6.8-#1 fix: employee unlock — clear pre-auth gate so portal renders.
  document.documentElement.classList.remove('pre-auth');"""

NEW = """function appUnlockEmployee(emp) {
  // Portal-hours-match-manager fix: normalize id aliasing for EVERY
  // entry point into the portal. Real login already does this via
  // _bootResolveEmployeeFromAuth; several "Preview as employee" paths
  // instead pass a raw facade row (getStaffList()/PentaEmployees.listSync())
  // whose .id is the Supabase uuid, not legacy_roster_id -- the key
  // getEmpHours/getEmployeeTeam/dailyAssignments all actually read.
  // Confirmed live: every one of the 25 currently-active employees has
  // a legacy_roster_id that differs from their uuid, so this affected
  // every Preview session through that entry point, for every
  // employee, every time.
  try {
    if (emp && emp.legacy_roster_id && emp.id !== emp.legacy_roster_id) {
      if (emp.uuid == null) emp.uuid = emp.id;
      emp.id = emp.legacy_roster_id;
    }
  } catch (e) { console.warn('[appUnlockEmployee] id-alias normalization failed (non-fatal)', e); }
  // Bug 6.8-#1 fix: employee unlock — clear pre-auth gate so portal renders.
  document.documentElement.classList.remove('pre-auth');"""

EDITS = [("appUnlockEmployee: normalize id aliasing for every entry point (Preview + real login)", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
