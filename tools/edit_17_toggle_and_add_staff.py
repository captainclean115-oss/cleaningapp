#!/usr/bin/env python3
"""Salary amount/period follow-up:
  1. Extend _staffToggleHourlyFieldsForPayType to show/hide the new
     Salary amount/period fields based on Pay Type alone (not Admin-
     scoped like the Pay Rate dimming above it -- a salaried FIELD
     employee can still have a salary amount on file, per spec), and
     to show the "kept on file" note when switching back to Hourly
     with a stored value present.
  2. openAddStaff: blank the two new fields for a brand-new hire (same
     treatment as every other field reset there).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "extend _staffToggleHourlyFieldsForPayType for salary amount/period fields",
        """  if (hint) hint.style.display = formIsSalariedAdmin ? '' : 'none';
}

function openAddStaff() {""",
        """  if (hint) hint.style.display = formIsSalariedAdmin ? '' : 'none';

  // Salary amount/period (migration 114 follow-up). Shown whenever Pay
  // Type = Salaried, regardless of Work Type -- unlike the Admin-only
  // Pay Rate dimming above, the spec is explicit this isn't
  // Admin-scoped. Switching back to Hourly hides the inputs WITHOUT
  // clearing their values (saveStaffEmployee simply never writes these
  // columns when Pay Type isn't Salaried at save time, so whatever was
  // last saved stays in the database) -- the note below just tells
  // Tom that's what's happening instead of leaving him to wonder.
  try {
    var isSalaried = ptSel.value === 'salary';
    var salaryFields = document.getElementById('staff-salary-fields');
    var keptNote = document.getElementById('staff-salary-kept-note');
    if (salaryFields) salaryFields.style.display = isSalaried ? '' : 'none';
    if (keptNote) {
      var amtEl = document.getElementById('staff-salary-amount');
      var perEl = document.getElementById('staff-salary-period');
      var hasStoredSalary = !!((amtEl && String(amtEl.value || '').trim()) || (perEl && perEl.value));
      keptNote.style.display = (!isSalaried && hasStoredSalary) ? '' : 'none';
    }
  } catch (e) { console.warn('[_staffToggleHourlyFieldsForPayType] salary fields toggle failed', e); }
}

function openAddStaff() {""",
    ),
    (
        "openAddStaff: reset salary amount/period for a new hire",
        """    set('staff-pay-type', 'hourly'); // new hires default to hourly, never salaried
    if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();
    if (typeof _staffToggleHourlyFieldsForPayType === 'function') _staffToggleHourlyFieldsForPayType();""",
        """    set('staff-pay-type', 'hourly'); // new hires default to hourly, never salaried
    set('staff-salary-amount', ''); set('staff-salary-period', '');
    if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();
    if (typeof _staffToggleHourlyFieldsForPayType === 'function') _staffToggleHourlyFieldsForPayType();""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
