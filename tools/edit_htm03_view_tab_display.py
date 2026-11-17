#!/usr/bin/env python3
"""Hire-transfer-missing-fields fix -- PART 3. The manager-facing Staff
"View" tab already had a row for almost every field this fix
transfers (confirmed by reading renderStaffView before touching
anything) -- it just never had data to show, since hireApplicant never
wrote it. Adds the 3 genuinely-new fields (has_reliable_transportation,
prior_employer, earliest_start_date) plus state (an existing employees
column the address line never included, even though the application
form -- and this same view's edit counterpart -- already had nowhere
for it; included now for completeness since the mapping now writes it
whenever an application does provide it).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    ${section('Personal Info', [
      row('Phone', emp.phone),
      row('Email', emp.email),
      row('Address', emp.address ? emp.address + (emp.city ? ', ' + emp.city : '') + (emp.zip ? ' ' + emp.zip : '') : ''),
      row('Birthday', emp.birthday),
      row('Language', {en:'English',es:'Spanish',pt:'Portuguese',cv:'Kriolu'}[emp.lang] || emp.lang),
    ])}

    ${section('Employment', [
      row('Team', emp.team),
      row('Pay Rate', emp.payRate ? '$' + emp.payRate + '/hr' : ''),
      row('Shirt Size', emp.shirtSize),
      row('Pants Size', emp.pantsSize),
      row('Work Auth', emp.workAuth),
      row("Driver's License", emp.hasLicense),
    ])}

    ${section('Experience & Availability', [
      rowAlways('Experience', {none:'No experience',some:'Less than 1 year','1-2':'1-2 years','3+':'3+ years'}[emp.experience] || emp.experience),
      rowAlways('Experience Notes', emp.expNotes),
      rowAlways('Days Available', emp.availDays && emp.availDays.length ? emp.availDays.join(', ') : ''),
      rowAlways('Preferred Start', {early:'Early (7-8am)',morning:'Morning (8-9am)',flexible:'Flexible'}[emp.prefTime] || emp.prefTime),
      rowAlways('Languages Spoken', emp.languages && emp.languages.length ? emp.languages.join(', ') : ''),
    ])}"""

NEW = """    ${section('Personal Info', [
      row('Phone', emp.phone),
      row('Email', emp.email),
      row('Address', emp.address ? emp.address + (emp.city ? ', ' + emp.city : '') + (emp.state ? ', ' + emp.state : '') + (emp.zip ? ' ' + emp.zip : '') : ''),
      row('Birthday', emp.birthday),
      row('Language', {en:'English',es:'Spanish',pt:'Portuguese',cv:'Kriolu'}[emp.lang] || emp.lang),
    ])}

    ${section('Employment', [
      row('Team', emp.team),
      row('Pay Rate', emp.payRate ? '$' + emp.payRate + '/hr' : ''),
      row('Shirt Size', emp.shirtSize),
      row('Pants Size', emp.pantsSize),
      row('Work Auth', emp.workAuth),
      row("Driver's License", emp.hasLicense),
    ])}

    ${section('Experience & Availability', [
      rowAlways('Experience', {none:'No experience',some:'Less than 1 year','1-2':'1-2 years','3+':'3+ years'}[emp.experience] || emp.experience),
      rowAlways('Experience Notes', emp.expNotes),
      rowAlways('Days Available', emp.availDays && emp.availDays.length ? emp.availDays.join(', ') : ''),
      rowAlways('Preferred Start', {early:'Early (7-8am)',morning:'Morning (8-9am)',flexible:'Flexible'}[emp.prefTime] || emp.prefTime),
      rowAlways('Languages Spoken', emp.languages && emp.languages.length ? emp.languages.join(', ') : ''),
      row('Prior Employer', emp.prior_employer),
      row('Reliable Transportation', emp.has_reliable_transportation === true ? 'Yes' : emp.has_reliable_transportation === false ? 'No' : ''),
      row('Earliest Start Date', emp.earliest_start_date),
    ])}"""

EDITS = [
    ("Hire-transfer-missing-fields fix: Staff View tab shows the new fields + state", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
