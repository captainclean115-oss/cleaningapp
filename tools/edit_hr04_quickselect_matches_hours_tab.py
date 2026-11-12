#!/usr/bin/env python3
"""Hours-report-match-hours-tab fix -- STEP 3 (part 4), the actual root
cause for Oneida Rojas showing 46h in the report vs 42h on the Hours
tab for "last week."

DIAGNOSIS: the report's "This week"/"Last week" quick-selects computed
their OWN Mon-Sun (7 calendar day) span via _computeLastPayWeekRange/
manual date math. The Hours tab's per-employee view (getWeekDates)
only EVER considers 5 weekdays (Mon-Fri) for any week, by construction
-- it never looks at Saturday/Sunday at all, for any employee. Real
data (Supabase, read-only): Manna Maids has essentially no weekend
operations (zero scheduled jobs either team, 2026-11-07/08), but team
M2 had an unscheduled, date-scoped device reassignment on exactly
2026-11-07 (team_device_assignments) with no matching job, employee
assignment, or override -- the report's wider 7-day range picked up
whatever incidental GPS activity that produced and attributed it, via
the team-average fallback, to every M2-default employee (Oneida,
Katerin Yagut, Pia Stancov) that week; the Hours tab structurally never
even asks about that day. 42h (Hours tab) is Oneida's correct total;
46h (report) was inflated by a non-workday.

Fix: "This week"/"Last week" now call getWeekDates (the Hours tab's
OWN week-definition function) directly for the SAME offset, instead of
a separately-computed 7-day span -- guaranteed to be the exact same
dates the Hours tab would show for that week, for any employee. The
general custom date-range picker (typing From/To by hand) is
untouched -- Tom can still enter any range, weekends included, on
purpose.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// "This week"/"Last week" quick-selects respect the per-business pay
// week setting (businesses.pay_week_start_day, migration 111) -- same
// helper the GPS filter uses, never a hardcoded Mon-Sun/Sun-Sat.
function _hoursReportQuickSelect(which) {
  var fromEl = document.getElementById('hours-report-from');
  var toEl = document.getElementById('hours-report-to');
  if (!fromEl || !toEl) return;
  var tz = _pentaBusinessTimezone();
  var startDay = _pentaPayWeekStartDay();
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  if (which === 'lastweek') {
    var r = _computeLastPayWeekRange(tz, startDay);
    fromEl.value = r.startYmd;
    toEl.value = r.endYmd;
    return;
  }
  // 'thisweek' -- the week containing today, same start-day convention.
  var startDayNum = startDay === 'sunday' ? 0 : 1;
  var today = _bizTodayParts(tz);
  var todayUtcMidnight = Date.UTC(today.y, today.m - 1, today.d);
  var weekday = new Date(todayUtcMidnight).getUTCDay();
  var daysSinceStart = (weekday - startDayNum + 7) % 7;
  var weekStart = new Date(todayUtcMidnight - daysSinceStart * 86400000);
  var weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
  fromEl.value = weekStart.getUTCFullYear() + '-' + pad2(weekStart.getUTCMonth() + 1) + '-' + pad2(weekStart.getUTCDate());
  toEl.value = weekEnd.getUTCFullYear() + '-' + pad2(weekEnd.getUTCMonth() + 1) + '-' + pad2(weekEnd.getUTCDate());
}"""

NEW = """// Hours-report-match-hours-tab fix: "This week"/"Last week" must be
// the EXACT same days getWeekDates (the Hours tab's own week
// definition, Mon-Fri only) would show for that offset -- not a
// separately-computed Mon-Sun 7-day span, which silently included
// Saturday/Sunday the Hours tab's per-employee view never looks at,
// inflating anyone with incidental weekend GPS/device activity on a
// day nobody was actually scheduled to work (see this fix's own
// deploy notes for the real data that confirmed it). The general
// custom date-range picker (typing From/To by hand) is untouched.
function _hoursReportQuickSelect(which) {
  var fromEl = document.getElementById('hours-report-from');
  var toEl = document.getElementById('hours-report-to');
  if (!fromEl || !toEl) return;
  var offset = (which === 'lastweek') ? -1 : 0;
  var wd = getWeekDates(offset);
  fromEl.value = dateKey(wd[0]);
  toEl.value = dateKey(wd[wd.length - 1]);
}"""

EDITS = [("Hours-report-match-hours-tab fix: quick-selects reuse getWeekDates, matching the Hours tab exactly", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
