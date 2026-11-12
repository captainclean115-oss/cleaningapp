#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2. Hours tab per-day cell shows the
small unconfirmed warning badge (tap for the explanation) whenever
resolveEmployeeDayHours flags the day isUnconfirmed. Tapping the badge
itself shows the explanation without also opening the normal day-detail
view (event.stopPropagation()); tapping anywhere else on the cell still
opens showEmpDayDetail as before.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """        const hrsHtml = empH > 0
          ? '<div class="hrs-day-hrs">' + _hrsFmtHrs(empH) + '<span style="font-size:9px;font-weight:600;color:var(--muted);margin-left:1px">h</span></div>'
          : '<div class="hrs-day-hrs is-dash">&#8212;</div>';
        // Cross-team day tag -- visible marker (not a duplicate row) when
        // this specific day's real team differs from the card's team.
        const teamTag = dayTeam !== team
          ? '<div class="hrs-day-time" style="color:' + _pentaTeamColor(dayTeam, '#6b7280') + ';font-weight:700">' + _audEsc(dayTeam) + '</div>'
          : '';
        const timeHtml = teamTag
          + (sStr ? '<div class="hrs-day-time hrs-day-time-start">' + _audEsc(sStr) + '</div>' : '')
          + ((!isOpen && eStr) ? '<div class="hrs-day-time hrs-day-time-end">' + _audEsc(eStr) + '</div>' : '')
          + (lunchMin ? '<div class="hrs-day-time" style="color:#f59e0b">&#127828; ' + lunchMin + 'm</div>' : '')
          + (override ? '<div class="hrs-day-edited">EDITED</div>' : '')
          + (isOpen ? '<div class="hrs-day-live">live</div>' : '');"""

NEW = """        const hrsHtml = empH > 0
          ? '<div class="hrs-day-hrs">' + _hrsFmtHrs(empH) + '<span style="font-size:9px;font-weight:600;color:var(--muted);margin-left:1px">h</span></div>'
          : '<div class="hrs-day-hrs is-dash">&#8212;</div>';
        // Hours-weekend-days fix: hours with no job or assignment behind
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
        const timeHtml = unconfirmedBadge + teamTag
          + (sStr ? '<div class="hrs-day-time hrs-day-time-start">' + _audEsc(sStr) + '</div>' : '')
          + ((!isOpen && eStr) ? '<div class="hrs-day-time hrs-day-time-end">' + _audEsc(eStr) + '</div>' : '')
          + (lunchMin ? '<div class="hrs-day-time" style="color:#f59e0b">&#127828; ' + lunchMin + 'm</div>' : '')
          + (override ? '<div class="hrs-day-edited">EDITED</div>' : '')
          + (isOpen ? '<div class="hrs-day-live">live</div>' : '');"""

EDITS = [("Hours-weekend-days fix: unconfirmed badge on the Hours tab day cell", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
