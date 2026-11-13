#!/usr/bin/env python3
"""Weekend-hours-assignment-only fix -- PART 1 + PART 2.

resolveEmployeeDayHours (the one shared per-day hours function) gets
two new guards, both ahead of every other precedence rule, so every
caller (Hours tab, weekly total, report, portal publish, payroll)
inherits them with no per-screen filtering:

1. Termination/roster guard (PART 2 -- the Emilia bug). An employee
   not on the roster as of this exact date (terminated on/before it)
   never has hours, full stop -- even if a stale daily_assignments row
   exists for that date (the confirmed root cause: getEmployeeTeam's
   explicit-assignment branch never checked termination at all).

2. Weekend-assignment-only guard (PART 1 -- the Blanca/Ana bug). On a
   Saturday or Sunday, the normal default-team fallback never applies
   unless Tom put this exact employee on a team (or OFF) for this
   exact date in Team Assignments. No default team, no team-average
   GPS/vehicle blend, no spreading -- weekend hours exist only when
   explicitly assigned. A manual override is itself explicit and is
   checked before this guard runs, so it's never blocked by it.

Also removes the isUnconfirmed concept entirely (PR #228's badge/skip
design, overridden by Tom's stricter rule) -- replaced by the above:
an unassigned weekend day now correctly resolves to the existing
isOff:true/hours:0 shape instead of a flagged-but-counted hour.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData) {
  var dk = dateKey(d);
  var dayTeam = getEmployeeTeam(empId, dk);
  if (!dayTeam) {
    // Genuinely off / unassigned that day (not just "off THIS team").
    return {
      dayTeam: null, isOff: true,
      hours: 0, startStr: '', endStr: '', startDate: null, endDate: null,
      lunchMin: 0, isOpenShift: false, isOverride: false
    };
  }
  var dayData = weekHoursData[dayTeam];
  var override = getEmpHours(empId, dk);
  var empMap = empHoursMapData[empId] || {};"""

NEW = """function resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData) {
  var dk = dateKey(d);

  // Weekend-hours-assignment-only fix -- PART 2 (the Emilia bug).
  // Checked first, before any override/team/assignment logic: an
  // employee not on the roster as of THIS exact date (terminated
  // on/before it) never has hours, even if a stale daily_assignments
  // row exists for the date (getEmployeeTeam's explicit-assignment
  // branch never checked termination -- that row alone used to
  // resurrect her hours past termination).
  var _onRosterToday = (typeof getUnifiedRoster === 'function')
    && getUnifiedRoster(dk).some(function (e) { return e.id === empId; });
  if (!_onRosterToday) {
    return {
      dayTeam: null, isOff: true,
      hours: 0, startStr: '', endStr: '', startDate: null, endDate: null,
      lunchMin: 0, isOpenShift: false, isOverride: false
    };
  }

  var dayTeam = getEmployeeTeam(empId, dk);
  var override = getEmpHours(empId, dk);

  // Weekend-hours-assignment-only fix -- PART 1 (the Blanca/Ana bug).
  // On a Saturday or Sunday, the default-team fallback never applies
  // unless Tom put this employee on a team (or OFF) for this exact
  // date in Team Assignments -- no default team, no team-average
  // GPS/vehicle blend, no spreading. A manual override is itself
  // explicit and is never blocked by this (checked first, above).
  var _dow = d.getDay();
  if (dayTeam && (_dow === 0 || _dow === 6) && !override) {
    var _hasExplicitAssignment = (typeof dailyAssignments !== 'undefined')
      && dailyAssignments[dk + '_' + empId] !== undefined;
    if (!_hasExplicitAssignment) dayTeam = null;
  }

  if (!dayTeam) {
    // Genuinely off / unassigned that day (not just "off THIS team"),
    // or an unassigned weekend day under the rule above.
    return {
      dayTeam: null, isOff: true,
      hours: 0, startStr: '', endStr: '', startDate: null, endDate: null,
      lunchMin: 0, isOpenShift: false, isOverride: false
    };
  }
  var dayData = weekHoursData[dayTeam];
  var empMap = empHoursMapData[empId] || {};"""

OLD2 = """  var lunchMin = override ? (override.lunch || 0)
    : (dayData && dayData.lunch && dayData.lunch[dayIdx] ? dayData.lunch[dayIdx].duration : 0);

  // Hours-weekend-days fix: hours sourced ONLY from the team's blended
  // GPS/vehicle average (no personal override, no personal GPS cell)
  // are "confirmed" by a real scheduled job for this team that day, or
  // an explicit daily_assignments entry for THIS employee that day --
  // either one means a human expected this day to be worked. With
  // neither, the hours are real vehicle/GPS activity but nothing ties
  // them to this employee specifically -- shown, never dropped, but
  // flagged so a manager reviews before trusting them for payroll or
  // publishing to the employee.
  var isUnconfirmed = false;
  if (hours > 0 && !override && !teCell) {
    var hasJob = (typeof jobs !== 'undefined' && Array.isArray(jobs)) && jobs.some(function (j) { return j.date === dk && j.team === dayTeam && !j.cancelled; });
    var hasAssignment = (typeof dailyAssignments !== 'undefined') && dailyAssignments[dk + '_' + empId] !== undefined;
    isUnconfirmed = !hasJob && !hasAssignment;
  }

  return {
    dayTeam: dayTeam, isOff: false,
    hours: hours, startStr: startStr, endStr: endStr, startDate: startDate, endDate: endDate,
    lunchMin: lunchMin, isOpenShift: isOpenShift, isOverride: !!override, isUnconfirmed: isUnconfirmed
  };
}"""

NEW2 = """  var lunchMin = override ? (override.lunch || 0)
    : (dayData && dayData.lunch && dayData.lunch[dayIdx] ? dayData.lunch[dayIdx].duration : 0);

  return {
    dayTeam: dayTeam, isOff: false,
    hours: hours, startStr: startStr, endStr: endStr, startDate: startDate, endDate: endDate,
    lunchMin: lunchMin, isOpenShift: isOpenShift, isOverride: !!override
  };
}"""

EDITS = [
    ("Weekend-hours-assignment-only fix: termination + weekend-assignment-only guards in resolveEmployeeDayHours", OLD, NEW),
    ("Weekend-hours-assignment-only fix: remove isUnconfirmed computation/field", OLD2, NEW2),
]

if __name__ == "__main__":
    apply_edits(EDITS)
