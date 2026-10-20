#!/usr/bin/env python3
"""Portal-hours-match-manager fix -- resolveEmployeeDayHours (just
extracted in edit_02) needs raw start/end Date objects, not just the
manager's pre-formatted display strings, so the portal's renderHours()
can feed them into its OWN existing (business-timezone-aware)
formatting path in renderHoursData -- unchanged there, this just gives
it real data to format instead of reading a stale cache. Takes the
real Date `d` instead of just its string key `dk` (derived internally
via dateKey(d)) so an override's "HH:MM" string can be combined with
the correct calendar date, exactly the same construction the portal's
Admin/Office branch already does for its own overrides.

The manager's renderHoursTable never reads startDate/endDate (it only
ever used startStr/endStr) -- these are pure additions, invisible to
existing behavior, which the full existing test suite (re-run after
this edit) confirms.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function resolveEmployeeDayHours(empId, dk, dayIdx, weekHoursData, empHoursMapData) {
  var dayTeam = getEmployeeTeam(empId, dk);
  if (!dayTeam) {
    // Genuinely off / unassigned that day (not just "off THIS team").
    return {
      dayTeam: null, isOff: true,
      hours: 0, startStr: '', endStr: '', lunchMin: 0, isOpenShift: false, isOverride: false
    };
  }
  var dayData = weekHoursData[dayTeam];
  var override = getEmpHours(empId, dk);
  var empMap = empHoursMapData[empId] || {};
  var teCell = empMap[dk] || null;
  var teamH = (dayData && Array.isArray(dayData.days)) ? (dayData.days[dayIdx] || 0) : 0;
  var teamSrc = dayData && dayData.source;
  var hours = override ? override.hours
    : (teCell ? teCell.hours : (teamSrc === 'time_entries' ? 0 : teamH));
  var isOpenShift = !!(teCell && teCell.openShift) && !override;

  var startStr = '', endStr = '';
  if (override) {
    if (override.start) startStr = _hrsFmt12(override.start);
    if (override.end) endStr = _hrsFmt12(override.end);
  } else if (teCell) {
    if (teCell.start) startStr = _hrsFmt12(teCell.start);
    if (teCell.end) endStr = _hrsFmt12(teCell.end);
  } else if (teamSrc !== 'time_entries') {
    if (dayData && dayData.starts && dayData.starts[dayIdx]) startStr = _hrsFmt12(dayData.starts[dayIdx]);
    if (dayData && dayData.ends && dayData.ends[dayIdx]) endStr = _hrsFmt12(dayData.ends[dayIdx]);
  }
  var lunchMin = override ? (override.lunch || 0)
    : (dayData && dayData.lunch && dayData.lunch[dayIdx] ? dayData.lunch[dayIdx].duration : 0);

  return {
    dayTeam: dayTeam, isOff: false,
    hours: hours, startStr: startStr, endStr: endStr, lunchMin: lunchMin,
    isOpenShift: isOpenShift, isOverride: !!override
  };
}"""

NEW = """function resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData) {
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
  var empMap = empHoursMapData[empId] || {};
  var teCell = empMap[dk] || null;
  var teamH = (dayData && Array.isArray(dayData.days)) ? (dayData.days[dayIdx] || 0) : 0;
  var teamSrc = dayData && dayData.source;
  var hours = override ? override.hours
    : (teCell ? teCell.hours : (teamSrc === 'time_entries' ? 0 : teamH));
  var isOpenShift = !!(teCell && teCell.openShift) && !override;

  var startStr = '', endStr = '', startDate = null, endDate = null;
  if (override) {
    if (override.start) {
      startStr = _hrsFmt12(override.start);
      var sp = override.start.split(':');
      var sd = new Date(d); sd.setHours(parseInt(sp[0], 10), parseInt(sp[1], 10), 0, 0);
      startDate = sd;
    }
    if (override.end) {
      endStr = _hrsFmt12(override.end);
      var ep = override.end.split(':');
      var ed = new Date(d); ed.setHours(parseInt(ep[0], 10), parseInt(ep[1], 10), 0, 0);
      endDate = ed;
    }
  } else if (teCell) {
    if (teCell.start) { startStr = _hrsFmt12(teCell.start); startDate = teCell.start; }
    if (teCell.end) { endStr = _hrsFmt12(teCell.end); endDate = teCell.end; }
  } else if (teamSrc !== 'time_entries') {
    if (dayData && dayData.starts && dayData.starts[dayIdx]) { startStr = _hrsFmt12(dayData.starts[dayIdx]); startDate = dayData.starts[dayIdx]; }
    if (dayData && dayData.ends && dayData.ends[dayIdx]) { endStr = _hrsFmt12(dayData.ends[dayIdx]); endDate = dayData.ends[dayIdx]; }
  }
  var lunchMin = override ? (override.lunch || 0)
    : (dayData && dayData.lunch && dayData.lunch[dayIdx] ? dayData.lunch[dayIdx].duration : 0);

  return {
    dayTeam: dayTeam, isOff: false,
    hours: hours, startStr: startStr, endStr: endStr, startDate: startDate, endDate: endDate,
    lunchMin: lunchMin, isOpenShift: isOpenShift, isOverride: !!override
  };
}"""

EDITS = [("resolveEmployeeDayHours: accept the real Date, return normalized startDate/endDate too", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
