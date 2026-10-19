#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- Claire's "she was
terminated on X" explanation. Reuses findEmployeeWithSuggestions
itself (not a reimplementation of its scoring) with the
_ROSTER_ALL_HISTORY_ASOF sentinel to check whether a name that didn't
resolve for the requested date belongs to someone who WAS terminated
by then -- the one case get_employee_hours/edit_employee_hours/
batch_edit_employee_hours should explain plainly instead of reporting
a generic employee_not_found.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  all.sort(function(a, b) { return a.dist - b.dist; });
  return { matches: [], suggestions: all.slice(0, 3).map(function(x) { return x.emp; }) };
}

// Tools that return information to Claire rather than perform an action."""

NEW = """  all.sort(function(a, b) { return a.dist - b.dist; });
  return { matches: [], suggestions: all.slice(0, 3).map(function(x) { return x.emp; }) };
}

// Terminated-employee date-awareness fix. Called only when a dated
// lookup found nothing -- checks whether that's because the name
// belongs to someone who was already terminated as of asOfDate (a real,
// explainable reason), as opposed to a genuinely unknown name. Re-runs
// findEmployeeWithSuggestions itself with _ROSTER_ALL_HISTORY_ASOF
// (not a reimplementation of its scoring/ambiguity logic) so an
// ambiguous historical name still reports ambiguous_employee the
// normal way instead of this shortcut guessing a winner. Returns null
// when there's no such explanation.
function _claireTerminatedExplanation(query, asOfDate) {
  try {
    var hist = findEmployeeWithSuggestions(query, _ROSTER_ALL_HISTORY_ASOF);
    if (hist.matches.length !== 1) return null;
    var fe = hist.matches[0];
    if (fe.status !== 'terminated' || !fe.terminated_at) return null;
    if (asOfDate < fe.terminated_at) return null; // not yet terminated as of asOfDate -- not the explanation
    return { name: fe.name, terminated_at: fe.terminated_at };
  } catch (e) { return null; }
}

// Tools that return information to Claire rather than perform an action."""

EDITS = [("add _claireTerminatedExplanation helper", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
