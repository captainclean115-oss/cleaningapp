#!/usr/bin/env python3
"""Payroll cost card bug fix, step 2: expose renderHoursTable's real
grandTotal so the payroll card can cross-check against the ACTUAL
number the Hours table just showed, not a second computation of the
same formula (which could never disagree with itself). Pure
bookkeeping -- renderHoursTable's own output is unchanged."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD = """  // All Teams summary
  html += '<div class="hrs-totals-bar">'
    + '<div class="hrs-totals-label">All Teams</div>'
    + '<div class="hrs-totals-val">' + _hrsFmtHrs(grandTotal) + '<span style="font-size:13px;font-weight:700;margin-left:2px">h</span></div>'
    + '</div>';"""

NEW = """  // Payroll cost card bug fix -- expose the exact number this bar is
  // about to show, captured BEFORE any other code can touch it, so the
  // payroll card (rendered right after this function returns) can
  // compare against the real figure the manager is looking at here.
  window._hrsLastGrandTotal = grandTotal;

  // All Teams summary
  html += '<div class="hrs-totals-bar">'
    + '<div class="hrs-totals-label">All Teams</div>'
    + '<div class="hrs-totals-val">' + _hrsFmtHrs(grandTotal) + '<span style="font-size:13px;font-weight:700;margin-left:2px">h</span></div>'
    + '</div>';"""

apply_edits([
    ("renderHoursTable: expose grandTotal via window._hrsLastGrandTotal for the payroll card's mismatch check", OLD, NEW),
])
