#!/usr/bin/env python3
"""Hours-weekend-days fix. renderHoursTable now derives dayNames itself
from the REAL days array whenever a caller's dayNames doesn't match its
length -- several call sites still pass a stale hardcoded
['Mon','Tue','Wed','Thu','Fri'] literal (now wrong twice over: too
short for a 7-day week, and wrong order entirely for a sunday-start
business). Self-correcting here means every one of those call sites
renders correctly without having to hunt down and fix each one
individually, including any this sprint's audit missed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function renderHoursTable(days, dayNames) {
  const teams = _pentaTeamNames();"""

NEW = """function renderHoursTable(days, dayNames) {
  // Hours-weekend-days fix: never trust a caller-supplied dayNames that
  // doesn't match days.length (several call sites still pass the old
  // hardcoded 5-element Mon-Fri literal) -- derive it fresh from the
  // real days array, which also gets the weekday ORDER right for a
  // sunday-start business (that literal always started "Mon").
  if (!Array.isArray(dayNames) || dayNames.length !== days.length) {
    dayNames = days.map(function (d) { return d.toLocaleDateString('en-US', { weekday: 'short' }); });
  }
  const teams = _pentaTeamNames();"""

EDITS = [("Hours-weekend-days fix: renderHoursTable self-corrects dayNames from days", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
