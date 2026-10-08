#!/usr/bin/env python3
"""Salary amount/period (follow-up to migration 113/PR #195) -- teach
PentaEmployees' _toRow/_fromRow/_TOROW_KNOWN_FIELDS about the two new
employees columns, so both insert() and update() carry them correctly
and listSync()/get() read them back. Uses `!== undefined` (not
`!= null`) on the _toRow write side, matching the existing team_id/
work_type/termination_reason precedent -- an explicit null must be able
to CLEAR a previously-saved salary_amount/salary_period (both blank is
an explicitly allowed state), while simply omitting the key (never
constructing it when Pay Type isn't Salaried) must leave the stored
value untouched.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "add salary_amount/salary_period to _TOROW_KNOWN_FIELDS",
        """    // Admin/Office designation (migration 113).
    work_type: 1
  };""",
        """    // Admin/Office designation (migration 113).
    work_type: 1,
    // Salaried Admin/Office follow-up -- migration 114.
    salary_amount: 1, salary_period: 1
  };""",
    ),
    (
        "_toRow: map salary_amount/salary_period",
        """    // payRate → pay_rate
    if (emp.payRate != null) row.pay_rate = emp.payRate;
    if (emp.pay_rate != null) row.pay_rate = emp.pay_rate;
    if (emp.pay_type != null) row.pay_type = emp.pay_type;""",
        """    // payRate → pay_rate
    if (emp.payRate != null) row.pay_rate = emp.payRate;
    if (emp.pay_rate != null) row.pay_rate = emp.pay_rate;
    if (emp.pay_type != null) row.pay_type = emp.pay_type;

    // Salaried Admin/Office follow-up (migration 114). `!== undefined`
    // so an explicit null can CLEAR a previously-saved value (both
    // blank is an allowed state) -- callers that don't want to touch
    // these columns at all (Pay Type isn't Salaried right now) must
    // simply never set the key on `emp`, not set it to null/undefined.
    if (emp.salary_amount !== undefined) row.salary_amount = emp.salary_amount;
    if (emp.salary_period !== undefined) row.salary_period = emp.salary_period;""",
    ),
    (
        "_fromRow: pass through salary_amount/salary_period",
        """    ['ssn_last4','address','city','state','zip','emergency_contact_name',
     'emergency_contact_phone','pay_type','manager_notes'].forEach(function(k){
      if (row[k] != null) emp[k] = row[k];
    });""",
        """    ['ssn_last4','address','city','state','zip','emergency_contact_name',
     'emergency_contact_phone','pay_type','manager_notes',
     'salary_amount','salary_period'].forEach(function(k){
      if (row[k] != null) emp[k] = row[k];
    });""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
