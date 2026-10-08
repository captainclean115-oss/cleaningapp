#!/usr/bin/env python3
"""Salary amount/period follow-up -- openEditStaff(): hydrate the two
new fields from the employee row BEFORE the toggle calls run (same
ordering reason as work_type/pay_type just above: the toggle call right
after needs to see the real stored value, not stale leftover state from
whichever employee was open before this one). Always hydrate regardless
of current Pay Type, so a stored salary reappears correctly if the
manager flips Pay Type back to Salaried later in the same session.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "openEditStaff: hydrate salary amount/period before toggle calls",
        """  var _ptSel = document.getElementById('staff-pay-type');
  if (_ptSel) _ptSel.value = (emp.pay_type === 'salary') ? 'salary' : 'hourly';
  if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();
  if (typeof _staffToggleHourlyFieldsForPayType === 'function') _staffToggleHourlyFieldsForPayType();""",
        """  var _ptSel = document.getElementById('staff-pay-type');
  if (_ptSel) _ptSel.value = (emp.pay_type === 'salary') ? 'salary' : 'hourly';
  // Salary amount/period (migration 114 follow-up). Hydrated regardless
  // of the Pay Type value just set above, so a previously-saved amount
  // reappears correctly if Tom flips Pay Type back to Salaried later in
  // this same edit session (see the "kept, not erased" note in the
  // toggle function).
  var _salAmtEl = document.getElementById('staff-salary-amount');
  if (_salAmtEl) _salAmtEl.value = (typeof _fmtSalaryAmountInput === 'function') ? _fmtSalaryAmountInput(emp.salary_amount != null ? emp.salary_amount : null) : (emp.salary_amount != null ? emp.salary_amount : '');
  var _salPerEl = document.getElementById('staff-salary-period');
  if (_salPerEl) _salPerEl.value = (emp.salary_period === 'year' || emp.salary_period === 'month' || emp.salary_period === 'week') ? emp.salary_period : '';
  if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();
  if (typeof _staffToggleHourlyFieldsForPayType === 'function') _staffToggleHourlyFieldsForPayType();""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
