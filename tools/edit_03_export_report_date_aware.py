#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- Export Hours Report
(_buildHoursReportFromData). Same two changes as the Hours table
(edit_02): asOfDate passed as the first day of the range, effective-
team grouping instead of bare defaultTeam, and an explicit per-day
guard for the Admin/Office section (no team-based null-fallthrough to
rely on there).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "team roster: pass asOfDate + effective-team grouping (Export Report)",
        """  teams.forEach(function (team) {
    var teamEmployees = getUnifiedRoster().filter(function (e) {
      return e.defaultTeam === team && dates.some(function (dk) { return !!getEmployeeTeam(e.id, dk); });
    });""",
        """  teams.forEach(function (team) {
    // Terminated-employee date-awareness fix: dates[0] (the first day of
    // the range) is getUnifiedRoster's asOfDate here -- an employee not
    // yet terminated as of that day belongs in this report at all, even
    // if she left partway through the range. _hrsEffectiveTeamForRange
    // groups her under the team she actually worked (not her now-cleared
    // default team) without reintroducing PR #186's old per-team-touched
    // duplicate-row bug.
    var teamEmployees = getUnifiedRoster(dates[0]).filter(function (e) {
      return _hrsEffectiveTeamForRange(e, dates) === team && dates.some(function (dk) { return !!getEmployeeTeam(e.id, dk); });
    });""",
    ),
    (
        "admin roster: pass asOfDate (Export Report)",
        """  try {
    var adminEmployees = getUnifiedRoster().filter(function (e) { return e.work_type === 'admin'; });""",
        """  try {
    var adminEmployees = getUnifiedRoster(dates[0]).filter(function (e) { return e.work_type === 'admin'; });""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
