#!/usr/bin/env python3
"""Published Hours feature. Manager-facing controls on the Hours Worked
section (the live surface -- #hours-table/#hours-week-label, confirmed by
grep to be what _loadWeekHoursInner/renderHoursTable actually write to,
not a shadow/legacy element): a small "Published to employees [time]"
indicator, a manual "Publish now" button, and a secondary "Publish last 4
weeks" backfill button (built per spec, not run by this patch).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    <div class="hours-title">Hours Worked</div>
    <div id="hours-table"><div class="hours-loading">Loading hours...</div></div>"""

NEW = """    <div class="hours-title">Hours Worked</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;flex-wrap:wrap">
      <div id="hours-published-indicator" style="font-size:11px;color:var(--muted)"></div>
      <div style="display:flex;gap:6px">
        <button onclick="publishWeekHoursNow()" id="hours-publish-now-btn" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;cursor:pointer">Publish now</button>
        <button onclick="publishLast4Weeks()" id="hours-publish-backfill-btn" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;cursor:pointer">Publish last 4 weeks</button>
      </div>
    </div>
    <div id="hours-table"><div class="hours-loading">Loading hours...</div></div>"""

EDITS = [("Manager Hours section: publish indicator + Publish now + backfill buttons", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
