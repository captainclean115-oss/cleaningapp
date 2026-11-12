#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2. The per-employee day-grid
(.hrs-days-grid) becomes horizontally scrollable: Mon-Fri fill the
visible width by default (same 5-column look as before), Saturday/
Sunday are reached by swiping left, same as the task's own spec. The
employee name/total row (.hrs-emp-row) is a SEPARATE block entirely
above this scrolling grid -- not part of it -- so it was already
always-visible ("sticky") by construction; no change needed there.

Also adds .hrs-day-unconfirmed, the small warning badge for a day
whose hours came only from team-average GPS/vehicle activity with no
job or assignment behind it (see resolveEmployeeDayHours's own
isUnconfirmed comment).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """.hrs-days-grid {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px;
}
.hrs-day {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 7px 4px;
  text-align: center; cursor: pointer;
  transition: transform .1s, border-color .12s;
  min-height: 70px;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
}"""

NEW = """.hrs-days-grid {
  display: flex; gap: 5px;
  overflow-x: auto;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
}
.hrs-day {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 7px 4px;
  text-align: center; cursor: pointer;
  transition: transform .1s, border-color .12s;
  min-height: 70px;
  /* Hours-weekend-days fix: fixed width so exactly 5 columns (Mon-Fri)
     fill the card by default, matching the old grid's look -- Sat/Sun
     overflow the row and are reached by swiping, never squeezed in. */
  flex: 0 0 calc((100% - 20px) / 5);
  scroll-snap-align: start;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
}
.hrs-day-unconfirmed { font-size: 11px; color: #f59e0b; font-weight: 800; margin-top: 1px; cursor: pointer; }"""

EDITS = [("Hours-weekend-days fix: .hrs-days-grid horizontal scroll + .hrs-day-unconfirmed badge", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
