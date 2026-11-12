#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2. _loadWeekHoursInner's own 5-day
assumptions: the week-label's "last day" (days[4]), DAYS_SHORT (now
derived from the real days, also fixing the weekday ORDER for a
sunday-start business), the time_entries/Geotab trip query's end-of-
week bound (days[4] -- was silently cutting the Geotab/time_entries
fetch off at Friday night, so even once getWeekDates returned 7 days,
Saturday/Sunday trips would never have been queried at all), and the
weekHours[team] initializer arrays (hardcoded 5-element [0,0,0,0,0]
literals -- now sized to the real week length).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """  const days = getWeekDates(hoursWeekOffset);
  const mon = days[0];
  const fri = days[4];
  const DAYS_SHORT = ['Mon','Tue','Wed','Thu','Fri'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Update week label
  const label = document.getElementById('hours-week-label');
  if (hoursWeekOffset === 0) {
    label.textContent = 'This Week';
  } else if (hoursWeekOffset === -1) {
    label.textContent = 'Last Week';
  } else {
    label.textContent = MONTHS[mon.getMonth()] + ' ' + mon.getDate() + ' – ' + MONTHS[fri.getMonth()] + ' ' + fri.getDate();
  }"""

NEW1 = """  const days = getWeekDates(hoursWeekOffset);
  const mon = days[0];
  const fri = days[days.length - 1];
  // Hours-weekend-days fix: derived from the real days array -- correct
  // length AND correct weekday order for a sunday-start business
  // (the old literal always started "Mon").
  const DAYS_SHORT = days.map(function (d) { return d.toLocaleDateString('en-US', { weekday: 'short' }); });
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Update week label
  const label = document.getElementById('hours-week-label');
  if (hoursWeekOffset === 0) {
    label.textContent = 'This Week';
  } else if (hoursWeekOffset === -1) {
    label.textContent = 'Last Week';
  } else {
    label.textContent = MONTHS[mon.getMonth()] + ' ' + mon.getDate() + ' – ' + MONTHS[fri.getMonth()] + ' ' + fri.getDate();
  }"""

OLD2 = """        var _weekStart = new Date(days[0].getFullYear(), days[0].getMonth(), days[0].getDate(), 0, 0, 0);
        var _weekEnd   = new Date(days[4].getFullYear(), days[4].getMonth(), days[4].getDate(), 23, 59, 59, 999);"""

NEW2 = """        var _weekStart = new Date(days[0].getFullYear(), days[0].getMonth(), days[0].getDate(), 0, 0, 0);
        var _lastDay = days[days.length - 1];
        var _weekEnd   = new Date(_lastDay.getFullYear(), _lastDay.getMonth(), _lastDay.getDate(), 23, 59, 59, 999);"""

OLD3 = """      trips = await _geotabCall('Get', {
        typeName: 'Trip',
        search: {
          fromDate: days[0].toISOString(),
          toDate: new Date(days[4].getFullYear(), days[4].getMonth(), days[4].getDate(), 23, 59, 59).toISOString(),
          includeOverlappedTrips: true
        },
        resultsLimit: 2000
      });"""

NEW3 = """      var _gpsLastDay = days[days.length - 1];
      trips = await _geotabCall('Get', {
        typeName: 'Trip',
        search: {
          fromDate: days[0].toISOString(),
          toDate: new Date(_gpsLastDay.getFullYear(), _gpsLastDay.getMonth(), _gpsLastDay.getDate(), 23, 59, 59).toISOString(),
          includeOverlappedTrips: true
        },
        resultsLimit: 2000
      });"""

OLD4 = """            if (!weekHours[team]) {
              weekHours[team] = {
                days:   [0,0,0,0,0],
                starts: [null,null,null,null,null],
                ends:   [null,null,null,null,null],
                lunch:  [null,null,null,null,null],
                total:  0,
                color:  _pentaTeamColor(team, '#6b7280'),
                source: 'time_entries'
              };
            }"""

NEW4 = """            if (!weekHours[team]) {
              weekHours[team] = {
                days:   days.map(function () { return 0; }),
                starts: days.map(function () { return null; }),
                ends:   days.map(function () { return null; }),
                lunch:  days.map(function () { return null; }),
                total:  0,
                color:  _pentaTeamColor(team, '#6b7280'),
                source: 'time_entries'
              };
            }"""

OLD5 = """      if (!weekHours[team]) {
        weekHours[team] = { days: [0,0,0,0,0], starts: [null,null,null,null,null], ends: [null,null,null,null,null], lunch: [null,null,null,null,null], total: 0, color: _pentaTeamColor(team, '#6b7280'), source: 'geotab' };
      } else {
        weekHours[team].lunch = weekHours[team].lunch || [null,null,null,null,null];
      }"""

NEW5 = """      if (!weekHours[team]) {
        weekHours[team] = { days: days.map(function () { return 0; }), starts: days.map(function () { return null; }), ends: days.map(function () { return null; }), lunch: days.map(function () { return null; }), total: 0, color: _pentaTeamColor(team, '#6b7280'), source: 'geotab' };
      } else {
        weekHours[team].lunch = weekHours[team].lunch || days.map(function () { return null; });
      }"""

EDITS = [
    ("Hours-weekend-days fix: week label + DAYS_SHORT derived from the real days array", OLD1, NEW1),
    ("Hours-weekend-days fix: time_entries query end-of-week bound uses the last day, not days[4]", OLD2, NEW2),
    ("Hours-weekend-days fix: Geotab trip query end-of-week bound uses the last day, not days[4]", OLD3, NEW3),
    ("Hours-weekend-days fix: weekHours[team] time_entries init sized to the real week length", OLD4, NEW4),
    ("Hours-weekend-days fix: weekHours[team] geotab init sized to the real week length", OLD5, NEW5),
]

if __name__ == "__main__":
    apply_edits(EDITS)
