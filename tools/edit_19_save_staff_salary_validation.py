#!/usr/bin/env python3
"""Salary amount/period follow-up -- saveStaffEmployee() validation.
Runs BEFORE any write (same placement discipline as the Work Type
switch confirm just above it). Blocks save with a visible alert (never
a silent return) for:
  - an unparseable/negative salary amount
  - Salaried with an amount but no period chosen
  - Salaried with a period but no amount
Both blank is explicitly allowed (not set yet). The validated,
rounded amount/period are captured into salaryAmount/salaryPeriod for
the write step later in this same function (edit_20).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "saveStaffEmployee: validate salary amount/period before any write",
        """    if (!confirm(_wtMsg)) { return; }
  }

  // Collect new doc photos if taken""",
        """    if (!confirm(_wtMsg)) { return; }
  }

  // Salary amount/period (migration 114 follow-up). Validated BEFORE
  // any write, same discipline as the Work Type confirm above -- never
  // a silent return, always a clear alert naming the problem. Both
  // blank is an explicitly allowed "not set yet" state; one filled
  // without the other is not.
  var salaryAmount = null;
  var salaryPeriod = null;
  if (newPayType === 'salary') {
    var _salParsed = (typeof _parseSalaryAmountInput === 'function')
      ? _parseSalaryAmountInput((document.getElementById('staff-salary-amount')||{}).value)
      : { ok: false, error: '_parseSalaryAmountInput missing' };
    if (!_salParsed.ok) { alert(_salParsed.error); return; }
    salaryAmount = _salParsed.value;
    var _salPeriodRaw = (document.getElementById('staff-salary-period')||{}).value || '';
    salaryPeriod = (_salPeriodRaw === 'year' || _salPeriodRaw === 'month' || _salPeriodRaw === 'week') ? _salPeriodRaw : null;
    if (salaryAmount != null && !salaryPeriod) { alert('You entered a salary amount for ' + name + ' but didn\\'t choose a pay period (per year / per month / per week). Pick one, or clear the amount.'); return; }
    if (salaryAmount == null && salaryPeriod) { alert('You chose a pay period for ' + name + ' but didn\\'t enter a salary amount. Enter one, or clear the period.'); return; }
  }

  // Collect new doc photos if taken""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
