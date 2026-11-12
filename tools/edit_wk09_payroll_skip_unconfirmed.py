#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2, "do not silently trust them" for
dollar amounts too. _computeWeekPayroll still counts an unconfirmed
day's HOURS (so its own totalHours keeps matching the Hours table's
grand total exactly -- renderPayrollCostCard cross-checks the two and
warns if they ever disagree, and they shouldn't, now that both show
the same weekend hours) but skips computing PAY for that day until a
manager has reviewed it -- same reasoning as publishWeekHours never
publishing it to the employee. cumBefore (the running total used for
the 40h overtime threshold) still includes it, so a later day's
overtime rate is never silently underestimated because of a day
pending review.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """      anyDayIncluded = true;
      totalHours += hrs;
      if (rate != null && hrs > 0) totalGrossCents += _computeDayPayCents(hrs, rate, cumBefore, overtimeEnabled);
      cumBefore += hrs;"""

NEW = """      anyDayIncluded = true;
      totalHours += hrs;
      if (rate != null && hrs > 0 && !rd.isUnconfirmed) totalGrossCents += _computeDayPayCents(hrs, rate, cumBefore, overtimeEnabled);
      cumBefore += hrs;"""

EDITS = [("Hours-weekend-days fix: _computeWeekPayroll excludes unconfirmed hours from pay, not from the hours total", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
