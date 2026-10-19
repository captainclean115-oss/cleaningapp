#!/usr/bin/env python3
"""Published Hours feature. "Updated [date time]" line under the portal
Hours tab's week-dates header.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """        <div class="section-title" id="week-label" style="margin:0">THIS WEEK</div>
        <div id="portal-week-dates" style="font-size:11px;color:var(--muted)"></div>
      </div>"""

NEW = """        <div class="section-title" id="week-label" style="margin:0">THIS WEEK</div>
        <div id="portal-week-dates" style="font-size:11px;color:var(--muted)"></div>
        <div id="portal-hours-updated" style="font-size:10px;color:var(--muted);margin-top:2px"></div>
      </div>"""

EDITS = [("Portal Hours tab: Updated-label element under week-dates", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
