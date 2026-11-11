#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 1.3, the deeper instance.

parseScheduleCommand (the offline fallback's own date parser, used only
when the real API call has already failed) anchored every relative
date ("today", "tomorrow", a weekday name) on `new Date()` -- the
DEVICE's local clock, not the business's configured timezone. Anchoring
on the business-timezone calendar day instead keeps every later
.getDay()/.setDate()/dateKey() call (all local-Date-method based, so
still internally consistent) pointed at the business's actual "today"
regardless of what timezone the phone itself is set to.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  // Find date
  var date = '';
  var today = new Date(); today.setHours(0,0,0,0);
  var dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  var shortDays = ['sun','mon','tue','wed','thu','fri','sat'];

  if (lower.includes('today')) {
    date = dateKey(today);"""

NEW = """  // Find date
  var date = '';
  // Claire proposal-resolve-verify: anchor "today" on the BUSINESS's
  // configured timezone, not the device's own clock/timezone setting.
  var _pscTzToday = _bizTodayParts(_pentaBusinessTimezone());
  var today = new Date(_pscTzToday.y, _pscTzToday.m - 1, _pscTzToday.d);
  var dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  var shortDays = ['sun','mon','tue','wed','thu','fri','sat'];

  if (lower.includes('today')) {
    date = dateKey(today);"""

EDITS = [("Claire proposal-resolve-verify: parseScheduleCommand anchors 'today' on business timezone", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
