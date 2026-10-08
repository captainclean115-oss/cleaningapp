#!/usr/bin/env python3
"""Salary amount/period follow-up -- replace the plain "Salaried" badge
text with the formatted "Salaried - $13,000/month" line (via the new
_fmtSalaryLine helper) in both renderStaffList's card and
renderStaffSubview's card. Both occurrences are byte-identical in
isolation (same bug class as before -- two near-identical templates),
so each old_string below extends far enough into its own card's unique
next line to disambiguate without guessing.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "renderStaffList card: formatted salary line",
        """          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? '<span style="color:#fbbf24;font-weight:700">Salaried</span>' : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
          <span data-invite-pill data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}"></span>""",
        """          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? `<span style="color:#fbbf24;font-weight:700">${(typeof _fmtSalaryLine === 'function' ? _fmtSalaryLine(emp) : 'Salaried')}</span>` : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
          <span data-invite-pill data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}"></span>""",
    ),
    (
        "renderStaffSubview card: formatted salary line",
        """          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? '<span style="color:#fbbf24;font-weight:700">Salaried</span>' : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
        </div>""",
        """          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? `<span style="color:#fbbf24;font-weight:700">${(typeof _fmtSalaryLine === 'function' ? _fmtSalaryLine(emp) : 'Salaried')}</span>` : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
        </div>""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
