#!/usr/bin/env python3
"""Payroll cost card bug fix, step 2b: move window._hrsLastGrandTotal's
assignment from BEFORE the "All Teams summary" html block to AFTER it.

Why: tests/salaried-admin-live-hours-section.test.js extracts
renderHoursTable's Admin/Office block in isolation, up to (but not
including) the literal '\\n\\n  // All Teams summary' marker. Putting the
new line immediately before that marker put it INSIDE that test's
extracted range, where `grandTotal` doesn't exist (it's a variable from
the outer, non-extracted scope) -- a ReferenceError at eval time, not a
real app bug. Moving the assignment to right after the All Teams block
keeps it well past that extraction boundary, with no change in meaning
(grandTotal is already fully computed either way, before or after the
html is built from it)."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD = """  // Payroll cost card bug fix -- expose the exact number this bar is
  // about to show, captured BEFORE any other code can touch it, so the
  // payroll card (rendered right after this function returns) can
  // compare against the real figure the manager is looking at here.
  window._hrsLastGrandTotal = grandTotal;

  // All Teams summary
  html += '<div class="hrs-totals-bar">'
    + '<div class="hrs-totals-label">All Teams</div>'
    + '<div class="hrs-totals-val">' + _hrsFmtHrs(grandTotal) + '<span style="font-size:13px;font-weight:700;margin-left:2px">h</span></div>'
    + '</div>';"""

NEW = """  // All Teams summary
  html += '<div class="hrs-totals-bar">'
    + '<div class="hrs-totals-label">All Teams</div>'
    + '<div class="hrs-totals-val">' + _hrsFmtHrs(grandTotal) + '<span style="font-size:13px;font-weight:700;margin-left:2px">h</span></div>'
    + '</div>';

  // Payroll cost card bug fix -- expose the exact number this bar just
  // showed, so the payroll card (rendered right after this function
  // returns) can compare against the real figure the manager is
  // looking at, not a second computation of the same formula.
  window._hrsLastGrandTotal = grandTotal;"""

apply_edits([
    ("renderHoursTable: relocate window._hrsLastGrandTotal assignment past the All-Teams block", OLD, NEW),
])
