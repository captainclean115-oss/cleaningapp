#!/usr/bin/env python3
"""Hours-weekend-days fix -- remaining scattered 5-day hardcodes:
_writeWeekHoursCache's archive-key end date, Claire's edit_employee_hours
cache-write range check, addLunch's lunch-array fallback, and
debugTrips' (dev debug tool) trip query end date.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """    // Archive this week's data with week key for history
    var weekKey = 'weekHours_' + dateKey(days[0]) + '_' + dateKey(days[4]);"""

NEW1 = """    // Archive this week's data with week key for history
    var weekKey = 'weekHours_' + dateKey(days[0]) + '_' + dateKey(days[days.length - 1]);"""

OLD2 = """        var _ehWeekDays = getWeekDates(hoursWeekOffset);
        var _ehDateObj = new Date(ehDate + 'T00:00:00');
        if (_ehDateObj >= _ehWeekDays[0] && _ehDateObj <= _ehWeekDays[4] && Object.keys(weekHours).length > 0) {"""

NEW2 = """        var _ehWeekDays = getWeekDates(hoursWeekOffset);
        var _ehDateObj = new Date(ehDate + 'T00:00:00');
        if (_ehDateObj >= _ehWeekDays[0] && _ehDateObj <= _ehWeekDays[_ehWeekDays.length - 1] && Object.keys(weekHours).length > 0) {"""

OLD3 = """  const days = getWeekDates(hoursWeekOffset);
  const lunchDate = new Date(days[dayIdx]);
  lunchDate.setHours(h, m, 0, 0);
  if (!weekHours[team]) return;
  if (!weekHours[team].lunch) weekHours[team].lunch = [null,null,null,null,null];"""

NEW3 = """  const days = getWeekDates(hoursWeekOffset);
  const lunchDate = new Date(days[dayIdx]);
  lunchDate.setHours(h, m, 0, 0);
  if (!weekHours[team]) return;
  if (!weekHours[team].lunch) weekHours[team].lunch = days.map(function () { return null; });"""

OLD4 = """    const days = getWeekDates(-1); // last week
    const trips = await _geotabCall('Get', {
      typeName: 'Trip',
      search: {
        deviceSearch: { id: b1.id },
        fromDate: days[0].toISOString(),
        toDate: new Date(days[4].getFullYear(), days[4].getMonth(), days[4].getDate(), 23,59,59).toISOString()
      },
      resultsLimit: 50
    });"""

NEW4 = """    const days = getWeekDates(-1); // last week
    const _dtLastDay = days[days.length - 1];
    const trips = await _geotabCall('Get', {
      typeName: 'Trip',
      search: {
        deviceSearch: { id: b1.id },
        fromDate: days[0].toISOString(),
        toDate: new Date(_dtLastDay.getFullYear(), _dtLastDay.getMonth(), _dtLastDay.getDate(), 23,59,59).toISOString()
      },
      resultsLimit: 50
    });"""

EDITS = [
    ("Hours-weekend-days fix: _writeWeekHoursCache archive key uses the real last day", OLD1, NEW1),
    ("Hours-weekend-days fix: Claire edit_employee_hours cache-write range check uses the real last day", OLD2, NEW2),
    ("Hours-weekend-days fix: addLunch's lunch-array fallback sized to the real week length", OLD3, NEW3),
    ("Hours-weekend-days fix: debugTrips (dev tool) trip query end date uses the real last day", OLD4, NEW4),
]

if __name__ == "__main__":
    apply_edits(EDITS)
