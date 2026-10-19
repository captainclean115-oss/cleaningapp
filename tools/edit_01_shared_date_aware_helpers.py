#!/usr/bin/env python3
"""Terminated-employee date-awareness fix. Shared helpers, placed right
after getUnifiedRoster() -- they all extend its existing asOfDate
contract rather than reimplementing any part of it (per explicit
instruction: "Do not duplicate the as-of logic. Call the one existing
function").
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  } catch(e) { console.warn('[6.5b] getUnifiedRoster failed:', e); }
  return rows;
}


// Daily assignments"""

NEW = """  } catch(e) { console.warn('[6.5b] getUnifiedRoster failed:', e); }
  return rows;
}

// Terminated-employee date-awareness fix. A sentinel asOfDate far
// before any real termination_at -- passing it to getUnifiedRoster()
// makes isTerminatedAsOf's own `asOfDate >= fe.terminated_at` check
// false for every real employee, so EVERY employee this business has
// ever had (active or terminated, any date) is included. Used only by
// the few surfaces that genuinely need "has this name ever belonged to
// anyone, regardless of status" (the Archived/Former Employees list,
// and Claire's "she was terminated on X" fallback message) -- not a
// second exclusion rule, just the existing one's own documented
// "fails toward shown" branch, forced open deliberately.
var _ROSTER_ALL_HISTORY_ASOF = '0001-01-01';

// Returns the team CARD an employee should be grouped under for a
// multi-day view (Hours table, Export Hours Report). An active
// employee: her current default team, unchanged -- identical to the
// pre-existing `e.defaultTeam` check this replaces, same result, same
// cost. A terminated employee's default team is cleared to '' at
// termination (terminateEmployee -> _setEmployeeDefaultTeam(id, '')),
// so `e.defaultTeam` alone would land her in no card at all (effectively
// "Unassigned") for a week she actually worked a real team -- this
// falls back to the most recent day IN THE VIEWED RANGE she had a
// real resolved team (getEmployeeTeam, already date-aware), so she
// lands in the team she actually worked, never Unassigned, and still
// appears under exactly ONE card (PR #109's single-row guarantee is
// preserved: this returns one team, not a set).
function _hrsEffectiveTeamForRange(emp, dateKeys) {
  if (emp.defaultTeam) return emp.defaultTeam;
  for (var i = dateKeys.length - 1; i >= 0; i--) {
    var t = getEmployeeTeam(emp.id, dateKeys[i]);
    if (t) return t;
  }
  return null;
}

// Mirrors getUnifiedRoster's own isTerminatedAsOf comparison exactly
// (see its comment just above), for gating a SINGLE per-day cell/row
// without rebuilding the whole roster array for every day in a range --
// needed specifically for Admin/Office hours, which have no team-based
// null-fallthrough to ride on the way field employees' day cells do
// (getEmployeeTeam already resolves null for a date on/after
// termination on its own; manual_hour_overrides has no such built-in
// cutoff, since termination never touches that table).
function _employeeExcludedAsOf(emp, dateStr) {
  return !!(emp && emp.status === 'terminated' && emp.terminated_at && dateStr >= emp.terminated_at);
}


// Daily assignments"""

EDITS = [
    ("add shared date-aware helpers after getUnifiedRoster", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
