#!/usr/bin/env python3
"""Portal-hours-match-manager fix -- extract renderHoursTable's per-day
cell precedence (manual override wins; else the employee's own live
GPS/clock cell; else, only as a last resort, the team's aggregate
average) into one shared function, resolveEmployeeDayHours(). This is
the exact root-cause fix the task requires: "do not write a second
copy of any calculation." Both renderHoursTable (below) and the
portal's renderHours() (edit_03) now call this one function instead of
each having their own copy of the precedence -- the portal's old copy
read a stale, device-local localStorage snapshot that was never
guaranteed to exist on a real employee's own device; this one reads
the SAME live weekHours/_empHoursMap renderHoursTable already uses.

Every line inside the new function is copied VERBATIM from the
pre-existing inline code (same variable derivations, same operator
precedence, same fallback order) -- this is a refactor, not a rewrite,
so renderHoursTable's own output is provably unchanged (see the
before/after test).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_CELL_BODY = """      const dayCells = days.map(function(d, i) {
        const dk = dateKey(d);
        const dayTeam = getEmployeeTeam(emp.id, dk);
        const isToday = d.toDateString() === today.toDateString();
        _hrsCellAssertions.push({ empId: emp.id, empUuid: emp.uuid, dk: dk, dayTeam: dayTeam, defaultTeam: emp.defaultTeam });

        if (!dayTeam) {
          // Genuinely off / unassigned that day (not just "off THIS team").
          const inner = '<div class="hrs-day-label">' + dayNames[i] + '</div>'
            + '<div class="hrs-day-num">' + d.getDate() + '</div>'
            + '<div class="hrs-day-hrs is-dash">&#8212;</div>'
            + '<div class="hrs-day-time" style="color:var(--muted)">OFF</div>';
          return '<div class="hrs-day is-off' + (isToday ? ' is-today' : '') + '">' + inner + '</div>';
        }

        const dayData = weekHours[dayTeam];
        const override = getEmpHours(emp.id, dk);
        const teCell = empMap[dk] || null;
        const teamH = (dayData && Array.isArray(dayData.days)) ? (dayData.days[i] || 0) : 0;
        const teamSrc = dayData && dayData.source;
        const empH = override ? override.hours
          : (teCell ? teCell.hours : (teamSrc === 'time_entries' ? 0 : teamH));
        empWeekTotal += empH;
        const isOpen = !!(teCell && teCell.openShift) && !override;
        if (isOpen) empHasOpenShift = true;

        let sStr = '', eStr = '';
        if (override) {
          if (override.start) sStr = _hrsFmt12(override.start);
          if (override.end) eStr = _hrsFmt12(override.end);
        } else if (teCell) {
          if (teCell.start) sStr = _hrsFmt12(teCell.start);
          if (teCell.end) eStr = _hrsFmt12(teCell.end);
        } else if (teamSrc !== 'time_entries') {
          if (dayData && dayData.starts && dayData.starts[i]) sStr = _hrsFmt12(dayData.starts[i]);
          if (dayData && dayData.ends && dayData.ends[i]) eStr = _hrsFmt12(dayData.ends[i]);
        }
        const lunchMin = override ? (override.lunch || 0)
          : (dayData && dayData.lunch && dayData.lunch[i] ? dayData.lunch[i].duration : 0);

        const hrsHtml = empH > 0"""

NEW_CELL_BODY = """      const dayCells = days.map(function(d, i) {
        const dk = dateKey(d);
        // Portal-hours-match-manager fix: the whole override/live-cell/
        // team-average precedence now lives in ONE shared function --
        // see resolveEmployeeDayHours's own comment for why. Every value
        // below is read off its return, not recomputed here.
        const _rd = resolveEmployeeDayHours(emp.id, dk, i, weekHours, empHoursMap);
        const dayTeam = _rd.dayTeam;
        const isToday = d.toDateString() === today.toDateString();
        _hrsCellAssertions.push({ empId: emp.id, empUuid: emp.uuid, dk: dk, dayTeam: dayTeam, defaultTeam: emp.defaultTeam });

        if (_rd.isOff) {
          // Genuinely off / unassigned that day (not just "off THIS team").
          const inner = '<div class="hrs-day-label">' + dayNames[i] + '</div>'
            + '<div class="hrs-day-num">' + d.getDate() + '</div>'
            + '<div class="hrs-day-hrs is-dash">&#8212;</div>'
            + '<div class="hrs-day-time" style="color:var(--muted)">OFF</div>';
          return '<div class="hrs-day is-off' + (isToday ? ' is-today' : '') + '">' + inner + '</div>';
        }

        const empH = _rd.hours;
        empWeekTotal += empH;
        const isOpen = _rd.isOpenShift;
        if (isOpen) empHasOpenShift = true;
        const sStr = _rd.startStr;
        const eStr = _rd.endStr;
        const lunchMin = _rd.lunchMin;
        const override = _rd.isOverride;

        const hrsHtml = empH > 0"""

EDITS = [
    (
        "add resolveEmployeeDayHours before renderHoursTable",
        "function renderHoursTable(days, dayNames) {",
        """// Portal-hours-match-manager fix. Resolves ONE employee's ONE day of
// hours -- team, numeric hours, start/end display strings, lunch
// minutes, and whether it's a still-open shift. This is the EXACT
// precedence renderHoursTable's per-day cell has always used (an
// explicit manual override always wins; else the employee's own live
// GPS/clock-derived cell; else, only as a last resort with no personal
// cell at all, the team's aggregate average) -- extracted into ONE
// shared function so the employee portal can compute the identical
// number instead of reading a stale, device-local localStorage
// snapshot that was never guaranteed to exist on a real employee's own
// device (manual_hour_overrides/GPS data is only ever written into
// that snapshot by a MANAGER's own loadWeekHours() call, on the
// manager's own device -- a real employee's phone never ran it).
//
// dayIdx is this date's 0-4 index within the 5-day week (Mon=0..Fri=4)
// weekHoursData/empHoursMapData arrays are indexed by. weekHoursData
// and empHoursMapData are passed explicitly (not read off the globals
// directly) so a caller computing an ISOLATED week (the portal, via
// its own temporary hoursWeekOffset) can pass its own fresh result
// without this function silently reading whichever week happened to
// be loaded globally at the moment.
function resolveEmployeeDayHours(empId, dk, dayIdx, weekHoursData, empHoursMapData) {
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
}

function renderHoursTable(days, dayNames) {""",
    ),
    ("renderHoursTable cell body: call resolveEmployeeDayHours instead of inlining", OLD_CELL_BODY, NEW_CELL_BODY),
]

if __name__ == "__main__":
    apply_edits(EDITS)
