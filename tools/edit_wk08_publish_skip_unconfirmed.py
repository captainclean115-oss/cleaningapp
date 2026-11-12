#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2, "do not silently trust them."
publishWeekHours never publishes an unconfirmed day (team-average GPS/
vehicle hours with no job or assignment behind them) to the employee
portal -- same skip pattern already used for an unresolved zero-hour
day. Once Tom reviews the Hours tab's unconfirmed badge and, if he
agrees it's real, re-enters the same hours (a normal manual edit),
isOverride becomes true and it publishes normally -- reusing the
existing edit-hours flow, no new write path needed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """      if (rd.hours === 0 && !rd.isOverride) {
        if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'unresolved -- no GPS/clock data yet' });
        return;
      }
      var fieldCumBefore = cumHoursByEmp[empUuid] || 0;"""

NEW = """      if (rd.hours === 0 && !rd.isOverride) {
        if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'unresolved -- no GPS/clock data yet' });
        return;
      }
      if (rd.isUnconfirmed) {
        skipped.push({ emp: emp.name, date: dk, reason: 'unconfirmed -- vehicle/GPS hours with no job or assignment, awaiting manager review' });
        return;
      }
      var fieldCumBefore = cumHoursByEmp[empUuid] || 0;"""

EDITS = [("Hours-weekend-days fix: publishWeekHours never publishes an unconfirmed day", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
