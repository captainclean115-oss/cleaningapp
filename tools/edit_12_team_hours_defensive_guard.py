#!/usr/bin/env python3
"""Edit 12/N -- salaried Admin/Office feature.

_teamHoursEligibility's `included` filter: Team Hours modal is already
structurally impossible to reach for ANY admin employee (salaried or
not) -- getEmployeeTeam(id, date) always returns null for them (no
defaultTeam, and _setEmployeeDefaultTeam/quickAssign both refuse to
ever give them a real team), so `getEmployeeTeam(e.id, dateStr) ===
team` can never match. Verified, not assumed -- see the PR description
for the full chain. This adds the SAME defensive second-guard
getTeamEmployees already has (`&& e.work_type !== 'admin'`), purely for
consistency/defense-in-depth against a future change to that guard
chain, not because it changes any observable behavior today.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "_teamHoursEligibility: defensive work_type guard on `included`, matching getTeamEmployees' own pattern",
        """  var included = roster.filter(function(e) { return getEmployeeTeam(e.id, dateStr) === team && isActive(e); });""",
        """  // Defensive second guard (matches getTeamEmployees' own pattern) --
  // getEmployeeTeam already can't return a real team for an Admin/
  // Office employee (verified: no defaultTeam, and both
  // _setEmployeeDefaultTeam and quickAssign refuse to ever set one),
  // so this can't change observable behavior today. It's here so this
  // modal can never silently include an Admin/Office employee (salaried
  // or not) even if that guard chain ever changes.
  var included = roster.filter(function(e) { return getEmployeeTeam(e.id, dateStr) === team && isActive(e) && e.work_type !== 'admin'; });""",
    ),
]

apply_edits(EDITS)
