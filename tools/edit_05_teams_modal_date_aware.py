#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- Teams modal
(renderTeamManager). dateStr is already a parameter/closure variable
throughout this function (it's a date-pickable modal, #team-mgr-date),
so every bare getUnifiedRoster() call here just needs that same
dateStr threaded through -- no new state.

Note: isActiveEmp(e) (reads getRosterTermData()/roster_term_data, a
localStorage key confirmed to be written by NOTHING anywhere in this
file -- grep for saveRosterTermData shows zero call sites) is already
permanently a no-op (always true) today. Left untouched here: it isn't
causing the bug (the bare getUnifiedRoster() calls are), and removing
dead code is out of scope for this fix.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "team roster: pass dateStr",
        """    const employees = getUnifiedRoster().filter(e => getEmployeeTeam(e.id, dateStr) === team && isActiveEmp(e));""",
        """    const employees = getUnifiedRoster(dateStr).filter(e => getEmployeeTeam(e.id, dateStr) === team && isActiveEmp(e));""",
    ),
    (
        "unassigned (floaters): pass dateStr",
        """  const unassigned = getUnifiedRoster().filter(e => !getEmployeeTeam(e.id, dateStr) && isActiveEmp(e) && e.work_type !== 'admin');""",
        """  const unassigned = getUnifiedRoster(dateStr).filter(e => !getEmployeeTeam(e.id, dateStr) && isActiveEmp(e) && e.work_type !== 'admin');""",
    ),
    (
        "unassigned2: pass dateStr",
        """  const unassigned2 = getUnifiedRoster().filter(e => {
    const assigned = getEmployeeTeam(e.id, dateStr);
    return (!assigned || assigned === '') && e.work_type !== 'admin';
  });""",
        """  const unassigned2 = getUnifiedRoster(dateStr).filter(e => {
    const assigned = getEmployeeTeam(e.id, dateStr);
    return (!assigned || assigned === '') && e.work_type !== 'admin';
  });""",
    ),
    (
        "admin/office roster: pass dateStr",
        """    const adminEmployees = getUnifiedRoster().filter(e => e.work_type === 'admin' && isActiveEmp(e));""",
        """    const adminEmployees = getUnifiedRoster(dateStr).filter(e => e.work_type === 'admin' && isActiveEmp(e));""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
