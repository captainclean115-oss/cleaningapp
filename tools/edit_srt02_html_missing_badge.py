#!/usr/bin/env python3
"""Schedule-revenue-total fix -- PART 2. The HTML element
_renderRevMissingPriceBadge writes into, right next to the revenue
button so it's clearly tied to that number.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """        <button id="cal-day-rev" onclick="cycleRevMode()" style="background:none;border:none;color:#22c55e;font-size:15px;font-weight:700;font-family:'DM Sans',sans-serif;cursor:pointer;padding:0;"></button>"""

NEW = """        <button id="cal-day-rev" onclick="cycleRevMode()" style="background:none;border:none;color:#22c55e;font-size:15px;font-weight:700;font-family:'DM Sans',sans-serif;cursor:pointer;padding:0;"></button>
        <!-- Schedule-revenue-total fix: tappable "N jobs have no price"
             indicator, populated by _renderRevMissingPriceBadge -- hidden
             (display:none) whenever every job on the day has a usable price. -->
        <span id="cal-day-rev-missing" style="display:none;background:rgba(248,113,113,0.15);color:#f87171;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;cursor:pointer"></span>"""

EDITS = [
    ("Schedule-revenue-total fix: add the missing-price badge element next to the revenue button", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
