#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2. resolveEmployeeDayHours (the ONE
shared per-day function the Hours tab, the Export Hours Report, the
payroll cost card, and publishWeekHours all call) now also reports
isUnconfirmed: true when a day's hours came ONLY from the team's
blended GPS/vehicle average -- no personal override, no personal GPS
cell -- AND there's neither a scheduled (non-cancelled) job for that
team that day nor an explicit daily_assignments entry for this
employee that day. Real data (Supabase, read-only) confirmed exactly
this shape for last Saturday: team M2 had a real, owner-initiated
device reassignment that day, but no job and no employee-level
assignment behind it, so nobody had explicitly confirmed WHO worked it.

Same rule for every day, weekday or weekend -- not a weekend-only
check. In practice a weekday almost always has a real job backing it
(so this rarely fires Mon-Fri), but the logic itself doesn't know or
care what day of the week it is.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  var lunchMin = override ? (override.lunch || 0)
    : (dayData && dayData.lunch && dayData.lunch[dayIdx] ? dayData.lunch[dayIdx].duration : 0);

  return {
    dayTeam: dayTeam, isOff: false,
    hours: hours, startStr: startStr, endStr: endStr, startDate: startDate, endDate: endDate,
    lunchMin: lunchMin, isOpenShift: isOpenShift, isOverride: !!override
  };
}"""

NEW = """  var lunchMin = override ? (override.lunch || 0)
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

EDITS = [("Hours-weekend-days fix: resolveEmployeeDayHours reports isUnconfirmed", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
