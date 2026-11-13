#!/usr/bin/env python3
"""Weekend-hours-assignment-only fix -- PART 3. Remove the rest of
PR #228's isUnconfirmed mechanism now that resolveEmployeeDayHours no
longer produces the field at all: the payroll-dollar exclusion, the
publish skip, the Hours-tab cell badge + its tap explanation, and the
badge's CSS rule.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_CSS = """.hrs-day-unconfirmed { font-size: 11px; color: #f59e0b; font-weight: 800; margin-top: 1px; cursor: pointer; }
"""
NEW_CSS = ""

OLD_PAYROLL = """      if (rate != null && hrs > 0 && !rd.isUnconfirmed) totalGrossCents += _computeDayPayCents(hrs, rate, cumBefore, overtimeEnabled);"""
NEW_PAYROLL = """      if (rate != null && hrs > 0) totalGrossCents += _computeDayPayCents(hrs, rate, cumBefore, overtimeEnabled);"""

OLD_PUBLISH = """      if (rd.isUnconfirmed) {
        skipped.push({ emp: emp.name, date: dk, reason: 'unconfirmed -- vehicle/GPS hours with no job or assignment, awaiting manager review' });
        return;
      }
      var fieldCumBefore = cumHoursByEmp[empUuid] || 0;"""
NEW_PUBLISH = """      var fieldCumBefore = cumHoursByEmp[empUuid] || 0;"""

OLD_BADGE = """        // Hours-weekend-days fix: hours with no job or assignment behind
        // them (team-average GPS/vehicle activity only) are shown, never
        // dropped, but flagged -- tap the badge for why; tap elsewhere
        // on the cell still opens the normal day detail.
        const unconfirmedBadge = (_rd.isUnconfirmed && empH > 0)
          ? '<div class="hrs-day-unconfirmed" onclick="event.stopPropagation();alert(\\'Hours from vehicle activity, no job or assignment on this day. Review and confirm if correct.\\')" title="Unconfirmed -- tap for why">&#9888;</div>'
          : '';
        // Cross-team day tag -- visible marker (not a duplicate row) when
        // this specific day's real team differs from the card's team.
        const teamTag = dayTeam !== team
          ? '<div class="hrs-day-time" style="color:' + _pentaTeamColor(dayTeam, '#6b7280') + ';font-weight:700">' + _audEsc(dayTeam) + '</div>'
          : '';
        const timeHtml = unconfirmedBadge + teamTag"""
NEW_BADGE = """        // Cross-team day tag -- visible marker (not a duplicate row) when
        // this specific day's real team differs from the card's team.
        const teamTag = dayTeam !== team
          ? '<div class="hrs-day-time" style="color:' + _pentaTeamColor(dayTeam, '#6b7280') + ';font-weight:700">' + _audEsc(dayTeam) + '</div>'
          : '';
        const timeHtml = teamTag"""

EDITS = [
    ("Weekend-hours-assignment-only fix: remove unconfirmed badge CSS rule", OLD_CSS, NEW_CSS),
    ("Weekend-hours-assignment-only fix: remove isUnconfirmed exclusion from payroll dollars", OLD_PAYROLL, NEW_PAYROLL),
    ("Weekend-hours-assignment-only fix: remove isUnconfirmed skip from publishWeekHours", OLD_PUBLISH, NEW_PUBLISH),
    ("Weekend-hours-assignment-only fix: remove unconfirmed badge from Hours tab cell", OLD_BADGE, NEW_BADGE),
]

if __name__ == "__main__":
    apply_edits(EDITS)
