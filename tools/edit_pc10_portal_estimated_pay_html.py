#!/usr/bin/env python3
"""Payroll cost tally feature. Container for the portal's estimated-pay
line, at the top of the week (between the hours total and the daily
breakdown) -- empty/hidden by default (_renderPortalEstimatedPay leaves
it blank whenever show_estimated_pay_to_employees is off).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    <div class="hours-total">
      <div class="hours-total-val" id="total-hrs">0h</div>
      <div class="hours-total-label" id="total-label">Total hours this week</div>
    </div>
    <div class="hours-card" id="hours-breakdown" style="touch-action:pan-y">"""

NEW = """    <div class="hours-total">
      <div class="hours-total-val" id="total-hrs">0h</div>
      <div class="hours-total-label" id="total-label">Total hours this week</div>
    </div>
    <div id="portal-estimated-pay"></div>
    <div class="hours-card" id="hours-breakdown" style="touch-action:pan-y">"""

EDITS = [("Portal Hours tab: estimated-pay line container", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
