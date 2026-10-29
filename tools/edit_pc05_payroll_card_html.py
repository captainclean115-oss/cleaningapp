#!/usr/bin/env python3
"""Payroll cost tally feature. Container for the payroll cost card,
placed above the Hours Worked title -- this whole section
(#hours-section) is manager-only already, no new gating needed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    <div class="hours-title">Hours Worked</div>"""

NEW = """    <div id="payroll-cost-card" style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px"></div>
    <div class="hours-title">Hours Worked</div>"""

EDITS = [("Hours section: payroll cost card container", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
