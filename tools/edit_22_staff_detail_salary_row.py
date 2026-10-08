#!/usr/bin/env python3
"""Salary amount/period follow-up -- Staff detail view's Employment
section. Shows "Pay: Salaried - $13,000/month" instead of "Pay Rate:
$X/hr" for a salaried employee (via the shared _fmtSalaryLine helper,
same formatting as the list/subview cards).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "Staff detail Employment section: salary row instead of Pay Rate when salaried",
        """      row('Team', emp.team),
      row('Pay Rate', emp.payRate ? '$' + emp.payRate + '/hr' : ''),""",
        """      row('Team', emp.team),
      (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp))
        ? row('Pay', (typeof _fmtSalaryLine === 'function' ? _fmtSalaryLine(emp) : 'Salaried'))
        : row('Pay Rate', emp.payRate ? '$' + emp.payRate + '/hr' : ''),""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
