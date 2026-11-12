#!/usr/bin/env python3
"""Hours-weekend-days fix. The portal's "today" highlight used to only
ever resolve to a valid index for Mon-Fri (dow 1-5) -- any other day
(the weekend, now a real part of the week) always got -1, so "today"
would never highlight on a Saturday/Sunday even though those rows now
exist. Looked up directly against the real week dates instead of
re-deriving it from getDay() arithmetic that only ever covered 5 days.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  let totalHrs = 0;
  const today = new Date().getDay(); // 0=Sun,1=Mon...5=Fri
  const todayIdx = today >= 1 && today <= 5 ? today - 1 : -1;

  // Load extra tasks for this employee
  var portalDays = getPortalWeekDates();"""

NEW = """  let totalHrs = 0;

  // Load extra tasks for this employee
  var portalDays = getPortalWeekDates();
  // Hours-weekend-days fix: looked up directly against the real week
  // dates (any day, not just Mon-Fri) instead of getDay() arithmetic
  // that only ever covered 5 days.
  var _todayDateObj = new Date(); _todayDateObj.setHours(0, 0, 0, 0);
  const todayIdx = portalDays.findIndex(function (d) { return d.getTime() === _todayDateObj.getTime(); });"""

EDITS = [("Hours-weekend-days fix: portal todayIdx works for any day of the week", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
