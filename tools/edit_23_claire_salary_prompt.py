#!/usr/bin/env python3
"""Salary amount/period follow-up -- Claire's system prompt. No new
tool is added (spec is explicit: Claire does not read, say, or edit
salary amounts). This is a plain instruction line so she deflects
cleanly to the Staff screen instead of guessing or trying to improvise
an answer from get_employee_hours/lookup_employee (neither of which
carry salary_amount -- she has no way to see it even if she tried).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "add Claire salary-deflection line to system prompt",
        """ Don\\'t try to work around this by editing their hours a different way -- there is nothing to edit. This never applies to a field (non-Admin/Office) employee, even if they happen to also be salaried.\\n'""",
        """ Don\\'t try to work around this by editing their hours a different way -- there is nothing to edit. This never applies to a field (non-Admin/Office) employee, even if they happen to also be salaried.\\n'
    +'If ' + _opName + ' asks what someone\\'s salary is, what they get paid, or to change a salary amount, tell them plainly that salary amounts are managed on the Staff screen, not something you can see or change. Don\\'t guess a number, and don\\'t try to derive one from hours or pay rate.\\n'""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
