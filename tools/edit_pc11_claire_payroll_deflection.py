#!/usr/bin/env python3
"""Payroll cost tally feature. No new Claire tool -- per spec, she just
deflects to the Hours tab's own payroll cost card when asked about
payroll cost/gross wages/employer taxes, instead of trying to estimate
it herself from get_employee_hours calls (which would be a second,
divergent calculation of something the Hours tab already computes).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    +'An employee shown as "(Admin/Office, Salaried)" has NO hours tracked at all -- fixed pay, not hourly. get_employee_hours reports "salaried, no hours tracked" for them; edit_employee_hours refuses with a plain message ("X is salaried, so there are no hours to edit"); batch_edit_employee_hours skips them and says so in the preview rather than failing the whole batch. Don\\'t try to work around this by editing their hours a different way -- there is nothing to edit. This never applies to a field (non-Admin/Office) employee, even if they happen to also be salaried.\\n'
    +'Total clients: '+PentaClients.count()+'\\n'"""

NEW = """    +'An employee shown as "(Admin/Office, Salaried)" has NO hours tracked at all -- fixed pay, not hourly. get_employee_hours reports "salaried, no hours tracked" for them; edit_employee_hours refuses with a plain message ("X is salaried, so there are no hours to edit"); batch_edit_employee_hours skips them and says so in the preview rather than failing the whole batch. Don\\'t try to work around this by editing their hours a different way -- there is nothing to edit. This never applies to a field (non-Admin/Office) employee, even if they happen to also be salaried.\\n'
    +'If '+_opName+' asks about payroll cost, gross wages, employer taxes, or "what will payroll cost this week" -- you have no tool for this and should never try to estimate it yourself from get_employee_hours calls (that would be a second, possibly different answer from what the Hours tab already shows). Tell them plainly: that\\'s on the Hours tab, under "Payroll cost this week."\\n'
    +'Total clients: '+PentaClients.count()+'\\n'"""

EDITS = [("Claire: deflect payroll-cost questions to the Hours tab", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
