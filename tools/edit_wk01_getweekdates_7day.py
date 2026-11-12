#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2/3. getWeekDates becomes the single,
shared 7-day week definition (Mon-Sun, or Sun-Sat per the business's
pay_week_start_day setting), used by the manager Hours tab, the
employee portal, and the Export Hours Report alike.

getPortalWeekDates now just delegates to getWeekDates instead of
keeping its own separate 5-day Mon-only implementation -- "same
behavior in manager view and employee view" can't drift apart once
there's only one function defining the week at all.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """function getWeekDates(offset) {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + (offset * 7));
  monday.setHours(0,0,0,0);
  const days = [];
  for (let i = 0; i < 5; i++) { // Mon-Fri only
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}"""

NEW1 = """// Hours-weekend-days fix: the ONE shared week definition, now the
// full 7 days (Mon-Sun, or Sun-Sat for a sunday-start business) --
// every caller (manager Hours tab, employee portal, Export Hours
// Report) gets Saturday/Sunday automatically, and all three stay
// exactly in sync since none of them compute a week range any other
// way. Still device-local time (unchanged from before this fix --
// not a timezone fix, just a day-count one).
function getWeekDates(offset) {
  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  const startDayNum = (typeof _pentaPayWeekStartDay === 'function' && _pentaPayWeekStartDay() === 'sunday') ? 0 : 1;
  const weekStart = new Date(now);
  const diff = (day - startDayNum + 7) % 7;
  weekStart.setDate(now.getDate() - diff + (offset * 7));
  weekStart.setHours(0,0,0,0);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    days.push(d);
  }
  return days;
}"""

OLD2 = """function getPortalWeekDates(offset) {
  var off = offset || 0;
  var today = new Date(); today.setHours(0,0,0,0);
  var dow = today.getDay(); // 0=Sun
  var mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + (off * 7));
  var days = [];
  for (var i = 0; i < 5; i++) { var d = new Date(mon); d.setDate(mon.getDate()+i); days.push(d); }
  return days;
}"""

NEW2 = """// Hours-weekend-days fix: delegates to getWeekDates (the Hours tab's
// own week definition) instead of a separate 5-day reimplementation --
// the employee portal now sees the exact same 7 days the manager does.
function getPortalWeekDates(offset) {
  return getWeekDates(offset || 0);
}"""

EDITS = [
    ("Hours-weekend-days fix: getWeekDates returns the full 7-day week", OLD1, NEW1),
    ("Hours-weekend-days fix: getPortalWeekDates delegates to getWeekDates", OLD2, NEW2),
]

if __name__ == "__main__":
    apply_edits(EDITS)
