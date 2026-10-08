#!/usr/bin/env python3
"""Salary amount/period follow-up -- Staff modal markup:
  1. New "Salary amount ($)" text input + "Pay period" select, directly
     under the Pay Type dropdown (shown whenever Pay Type = Salaried,
     regardless of Work Type -- the spec is explicit this isn't
     Admin-only). Hidden by default; toggled by
     _staffToggleHourlyFieldsForPayType (edit_17).
  2. A small "kept on file" note shown instead, when Pay Type is
     Hourly but a salary amount/period is already stored -- confirms
     switching away from Salaried never erases it.
  3. The actual fix for the $13,000 -> $12,998.75 bug: #staff-pay (Pay
     Rate $/hr) gets onwheel (blur on scroll, so the browser's native
     scroll-to-change-value behavior on a focused number input can
     never fire) and onkeydown (blocks ArrowUp/ArrowDown from stepping
     the value) guards. No change to its type/step -- same decimal
     hourly-rate entry as before, just can't be silently nudged.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "add salary amount/period fields + kept-note under Pay Type, fix Pay Rate wheel/arrow nudge",
        """        <div id="staff-pay-type-hint" style="display:none;font-size:11px;color:var(--amber);margin-top:5px">Salaried Admin/Office employees have a fixed pay rate and no hours tracked anywhere -- the hourly rate below doesn't apply.</div>
      </div>""",
        """        <div id="staff-pay-type-hint" style="display:none;font-size:11px;color:var(--amber);margin-top:5px">Salaried Admin/Office employees have a fixed pay rate and no hours tracked anywhere -- the hourly rate below doesn't apply.</div>
        <div id="staff-salary-fields" style="display:none;margin-top:10px">
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Salary amount ($)</div>
          <input type="text" inputmode="decimal" id="staff-salary-amount" placeholder="e.g. 13,000.00" onblur="_staffReformatSalaryAmountInput()" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none">
          <div style="font-size:12px;color:var(--muted);margin:10px 0 6px">Pay period</div>
          <select id="staff-salary-period" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none;appearance:none">
            <option value="">Choose one…</option>
            <option value="year">Per year</option>
            <option value="month">Per month</option>
            <option value="week">Per week</option>
          </select>
        </div>
        <div id="staff-salary-kept-note" style="display:none;font-size:11px;color:var(--muted);margin-top:8px">💰 Salary amount/period is kept on file, just hidden while Pay Type is Hourly.</div>
      </div>""",
    ),
    (
        "fix Pay Rate ($/hr) scroll-wheel/arrow-key silent nudge (the 12998.75 bug)",
        """<div id="staff-pay-rate-field"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Pay Rate ($/hr)</div><input type="number" id="staff-pay" step="0.25" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>""",
        """<div id="staff-pay-rate-field"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Pay Rate ($/hr)</div><input type="number" id="staff-pay" step="0.25" onwheel="this.blur()" onkeydown="if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();}" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
