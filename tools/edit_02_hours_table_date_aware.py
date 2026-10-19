#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- Hours table
(renderHoursTable). Two changes:
  1. Team-card roster: pass the FIRST day of the viewed range as
     asOfDate (getUnifiedRoster's own existing contract), and group by
     the new _hrsEffectiveTeamForRange fallback instead of bare
     e.defaultTeam, so a terminated employee whose default team was
     cleared still lands under the team she actually worked, never
     Unassigned. Per-day cells/totals need NO further change -- they
     already call getEmployeeTeam(emp.id, dk) fresh per cell, which is
     already date-aware (resolves null for a date on/after
     termination), so a day on/after her exclusion date already
     renders OFF and already contributes 0 to the total.
  2. Admin/Office roster: same asOfDate fix, plus an explicit per-day
     guard (_employeeExcludedAsOf) since Admin/Office hours have no
     team-based null-fallthrough to ride on.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "precompute day keys once before the teams loop",
        """  var _hrsCellAssertions = [];

  let html = '';

  teams.forEach(team => {""",
        """  var _hrsCellAssertions = [];

  let html = '';
  // Terminated-employee date-awareness fix. The FIRST day of the
  // viewed range is getUnifiedRoster's asOfDate for this whole render:
  // an employee not yet terminated as of that day belongs in this
  // week's table at all (even if she left partway through it) -- the
  // existing per-day cell logic below already correctly blanks out any
  // day on/after her actual termination date on its own.
  var _hrsDayKeys = days.map(dateKey);
  var _hrsRangeStartKey = _hrsDayKeys[0];

  teams.forEach(team => {""",
    ),
    (
        "team roster: pass asOfDate + effective-team grouping",
        """    const teamEmployees = getUnifiedRoster().filter(e => {
      return e.defaultTeam === team && days.some(d => !!getEmployeeTeam(e.id, dateKey(d)));
    });""",
        """    const teamEmployees = getUnifiedRoster(_hrsRangeStartKey).filter(e => {
      return _hrsEffectiveTeamForRange(e, _hrsDayKeys) === team && days.some(d => !!getEmployeeTeam(e.id, dateKey(d)));
    });""",
    ),
    (
        "admin roster: pass asOfDate + per-day exclusion guard",
        """  try {
    const adminEmployees = getUnifiedRoster().filter(e => e.work_type === 'admin');""",
        """  try {
    const adminEmployees = getUnifiedRoster(_hrsRangeStartKey).filter(e => e.work_type === 'admin');""",
    ),
    (
        "admin per-day cell: blank out days on/after her exclusion date",
        """        let empWeekTotal = 0;
        const dayCells = days.map(function(d, i) {
          const dk = dateKey(d);
          const isToday = d.toDateString() === today.toDateString();
          const offInfo = _adminEmpDayOff(emp.id, dk);
          if (offInfo) {""",
        """        let empWeekTotal = 0;
        const dayCells = days.map(function(d, i) {
          const dk = dateKey(d);
          const isToday = d.toDateString() === today.toDateString();
          // Terminated-employee date-awareness fix: Admin/Office hours
          // have no team-based null-fallthrough the way field employees'
          // day cells do (getEmployeeTeam already resolves null for a
          // date on/after termination on its own) -- manual_hour_overrides
          // has no such built-in cutoff (termination never touches that
          // table), so this day must be force-blanked explicitly.
          if (_employeeExcludedAsOf(emp, dk)) {
            const exInner = '<div class="hrs-day-label">' + dayNames[i] + '</div>'
              + '<div class="hrs-day-num">' + d.getDate() + '</div>'
              + '<div class="hrs-day-hrs is-dash">&#8212;</div>'
              + '<div class="hrs-day-time" style="color:var(--muted)">&#8212;</div>';
            return '<div class="hrs-day is-off' + (isToday ? ' is-today' : '') + '">' + exInner + '</div>';
          }
          const offInfo = _adminEmpDayOff(emp.id, dk);
          if (offInfo) {""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
