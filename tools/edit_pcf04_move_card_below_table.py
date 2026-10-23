#!/usr/bin/env python3
"""Payroll cost card bug fix, step 4: move the card BELOW the Hours
table, at the bottom of the Hours tab -- was between the week-nav
arrows and the "Hours Worked" title, i.e. above the table. The card's
own collapsible per-employee breakdown is untouched (still defaults to
collapsed, _payrollCardExpanded = false)."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD = """    <div id="payroll-cost-card" style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px"></div>
    <div class="hours-title">Hours Worked</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;flex-wrap:wrap">
      <div id="hours-published-indicator" style="font-size:11px;color:var(--muted)"></div>
      <div style="display:flex;gap:6px">
        <button onclick="publishWeekHoursNow()" id="hours-publish-now-btn" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;cursor:pointer">Publish now</button>
        <button onclick="publishLast4Weeks()" id="hours-publish-backfill-btn" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;cursor:pointer">Publish last 4 weeks</button>
      </div>
    </div>
    <div id="hours-table"><div class="hours-loading">Loading hours...</div></div>
  </div>"""

NEW = """    <div class="hours-title">Hours Worked</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px;flex-wrap:wrap">
      <div id="hours-published-indicator" style="font-size:11px;color:var(--muted)"></div>
      <div style="display:flex;gap:6px">
        <button onclick="publishWeekHoursNow()" id="hours-publish-now-btn" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;cursor:pointer">Publish now</button>
        <button onclick="publishLast4Weeks()" id="hours-publish-backfill-btn" style="background:none;border:1px solid var(--border);color:var(--muted);font-family:'DM Sans',sans-serif;font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;cursor:pointer">Publish last 4 weeks</button>
      </div>
    </div>
    <div id="hours-table"><div class="hours-loading">Loading hours...</div></div>
    <!-- Payroll cost card bug fix: moved below the Hours table (was
         above it, between the week-nav arrows and "Hours Worked") so
         the manager sees the real hours first, then the cost estimate
         derived from them. -->
    <div id="payroll-cost-card" style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-top:12px"></div>
  </div>"""

apply_edits([
    ("Hours tab markup: move #payroll-cost-card below #hours-table", OLD, NEW),
])
