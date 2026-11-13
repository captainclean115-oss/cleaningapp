#!/usr/bin/env python3
"""Hours-week-nav fix. The flaky "7d rolling window" assertion in
tests/hours-report-range-picker.test.js -- NOT the production code --
has its own DST bug: it diffs two `new Date(ymd+'T00:00:00')` values
with raw millisecond subtraction in the TEST RUNNER's local time. A
"spring forward" or "fall back" day inside that 7-day span makes the
local midnight-to-midnight gap 23h or 25h instead of 24h, so the
division by 86400000 comes out to 5.9583... or 6.0417... instead of
exactly 6 -- confirmed by replaying this exact assertion with "today"
set to a date in that window (Nov 2026, Mar 2026). The production
function under test (_hoursReportDefaultRange) is unaffected -- it
computes entirely in UTC-day space and returns the correct YYYY-MM-DD
strings either way. Fix: count calendar days via Date.UTC on the
parsed Y/M/D (never local-time arithmetic), which has no DST to be
sensitive to in the first place.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import _apply_edits as ae

ae.INDEX_HTML = os.path.join(os.path.dirname(__file__), "..", "tests", "hours-report-range-picker.test.js")

OLD = """  // ---- Live tab is on "Last 7 days" (rolling) ----
  {
    const sandbox = buildSandbox({ window: { _gpsActivityWindowMode: '7d' } });
    // "now" for _bizTodayParts is the real system clock here (not mocked)
    // -- just confirm the range is exactly 7 days ending today, business tz.
    const r = sandbox._hoursReportDefaultRange();
    const days = (new Date(r.to + 'T00:00:00') - new Date(r.from + 'T00:00:00')) / 86400000;
    check('a 7d rolling window default spans exactly 7 days', days, 6);
  }"""

NEW = """  // ---- Live tab is on "Last 7 days" (rolling) ----
  {
    const sandbox = buildSandbox({ window: { _gpsActivityWindowMode: '7d' } });
    // "now" for _bizTodayParts is the real system clock here (not mocked)
    // -- just confirm the range is exactly 7 days ending today, business tz.
    const r = sandbox._hoursReportDefaultRange();
    // Hours-week-nav fix: count CALENDAR days via Date.UTC on the
    // parsed Y/M/D, not a raw local-time Date subtraction -- the old
    // version was flaky whenever "today" fell within 7 days of a DST
    // transition (confirmed: Nov 2026 and Mar 2026 both reproduce it),
    // because a local midnight-to-midnight span across DST is 23h or
    // 25h, not 24h. Date.UTC has no DST at all, so this is exact
    // regardless of what day the suite happens to run on.
    function ymdToUtcDayNumber(ymd) {
      var p = ymd.split('-').map(Number);
      return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000;
    }
    const days = ymdToUtcDayNumber(r.to) - ymdToUtcDayNumber(r.from);
    check('a 7d rolling window default spans exactly 7 days', days, 6);
  }"""

EDITS = [
    ("Hours-week-nav fix: count calendar days via Date.UTC, not local-time subtraction", OLD, NEW),
]

if __name__ == "__main__":
    ae.apply_edits(EDITS)
