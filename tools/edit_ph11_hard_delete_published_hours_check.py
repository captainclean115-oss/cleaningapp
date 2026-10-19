#!/usr/bin/env python3
"""Published Hours feature. The existing hard-delete history gate
(_deleteEmployeeHistoryCounts, confirmed live on main via PR #197's own
merge commit 9c641f6) counts 8 tables but didn't know about
published_employee_hours -- an employee with months of published pay
history but nothing left in the other 8 tables would have shown "looks
safe to delete." Adding it here also matters now that migration 115 puts
an ON DELETE RESTRICT on employee_id: the UI should warn BEFORE the RPC
call hits that FK and fails with a raw constraint error.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """var _DELETE_EMPLOYEE_HISTORY_CHECKS = [
  ['Team assignments', 'daily_assignments'],
  ['Hours entries', 'time_entries'],
  ['Manual hour overrides', 'manual_hour_overrides'],
  ['Lunch breaks', 'lunch_breaks'],
  ['Reward points records', 'reward_ledger'],
  ['Reward redemptions', 'reward_redemptions'],
  ['Reward submissions', 'reward_submissions'],
  ['Submitted forms', 'forms'],
];"""

NEW = """var _DELETE_EMPLOYEE_HISTORY_CHECKS = [
  ['Team assignments', 'daily_assignments'],
  ['Hours entries', 'time_entries'],
  ['Manual hour overrides', 'manual_hour_overrides'],
  // Published Hours feature: published_employee_hours.employee_id is
  // ON DELETE RESTRICT (migration 115) -- any row here would already
  // block the RPC outright, but this count lets the manager see it and
  // choose Terminate instead, rather than hitting a raw FK error.
  ['Published hours', 'published_employee_hours'],
  ['Lunch breaks', 'lunch_breaks'],
  ['Reward points records', 'reward_ledger'],
  ['Reward redemptions', 'reward_redemptions'],
  ['Reward submissions', 'reward_submissions'],
  ['Submitted forms', 'forms'],
];"""

EDITS = [("Hard-delete gate: add published_employee_hours to the history-count list", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
