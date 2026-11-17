#!/usr/bin/env python3
"""Hire-transfer-missing-fields fix -- PART 5. Wires the 3 new edit-form
inputs (Reliable Transportation, Prior Employer, Earliest Start Date)
into: (a) openEditStaff's hydrate-on-open, so an existing value shows
when a manager opens an employee who has one; (b) the save function's
`emp` object build, which _toRow (via PentaEmployees.insert/update)
reads from; (c) the separate hand-built dual-write `patch` object this
same save function also maintains for existing employees -- a SECOND,
known-fragile mapping (its own comments already flag it as the exact
place `position`/`is_team_leader`/`is_driver`/`work_type` were each
separately forgotten before) that needs the same 3 fields added
explicitly or they would silently never persist for an EDIT (only for
a brand-new insert).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_HYDRATE = """  const emR = document.getElementById('staff-em-rel');
  if (emR) emR.value = emp.emergency_contact_relationship || emp.emRel || '';
  // Notes"""

NEW_HYDRATE = """  const emR = document.getElementById('staff-em-rel');
  if (emR) emR.value = emp.emergency_contact_relationship || emp.emRel || '';
  // Hire-transfer-missing-fields fix (migration 124).
  const relTransport = document.getElementById('staff-reliable-transport');
  if (relTransport) relTransport.value = emp.has_reliable_transportation === true ? 'yes' : emp.has_reliable_transportation === false ? 'no' : '';
  const priorEmployer = document.getElementById('staff-prior-employer');
  if (priorEmployer) priorEmployer.value = emp.prior_employer || '';
  const earliestStart = document.getElementById('staff-earliest-start');
  if (earliestStart) earliestStart.value = emp.earliest_start_date || '';
  // Notes"""

OLD_EMP_BUILD = """    emName: (document.getElementById('staff-em-name')||{}).value||'',
    emPhone: (document.getElementById('staff-em-phone')||{}).value||'',
    emRel: (document.getElementById('staff-em-rel')||{}).value||'',
    notes: (document.getElementById('staff-notes')||{}).value||'',"""

NEW_EMP_BUILD = """    emName: (document.getElementById('staff-em-name')||{}).value||'',
    emPhone: (document.getElementById('staff-em-phone')||{}).value||'',
    emRel: (document.getElementById('staff-em-rel')||{}).value||'',
    notes: (document.getElementById('staff-notes')||{}).value||'',
    // Hire-transfer-missing-fields fix (migration 124).
    has_reliable_transportation: (function () {
      var v = (document.getElementById('staff-reliable-transport')||{}).value||'';
      return v === 'yes' ? true : v === 'no' ? false : null;
    })(),
    prior_employer: (document.getElementById('staff-prior-employer')||{}).value||'',
    earliest_start_date: (document.getElementById('staff-earliest-start')||{}).value||'',"""

OLD_PATCH = """        if (emp.prefTime !== undefined) patch.preferred_start_time = emp.prefTime || null;
        if (emp.emRel !== undefined) patch.emergency_contact_relationship = emp.emRel || null;"""

NEW_PATCH = """        if (emp.prefTime !== undefined) patch.preferred_start_time = emp.prefTime || null;
        if (emp.emRel !== undefined) patch.emergency_contact_relationship = emp.emRel || null;
        // Hire-transfer-missing-fields fix (migration 124). Same
        // conditional gate as every other field in this hand-built
        // patch -- see this block's own comment above on why it is a
        // SEPARATE mapping from _toRow's and needs each field added
        // explicitly or it silently never persists for an edit.
        if (emp.has_reliable_transportation !== undefined) patch.has_reliable_transportation = emp.has_reliable_transportation;
        if (emp.prior_employer !== undefined) patch.prior_employer = emp.prior_employer || null;
        if (emp.earliest_start_date !== undefined) patch.earliest_start_date = emp.earliest_start_date || null;"""

EDITS = [
    ("Hire-transfer-missing-fields fix: hydrate the 3 new inputs on edit-form open", OLD_HYDRATE, NEW_HYDRATE),
    ("Hire-transfer-missing-fields fix: read the 3 new inputs into the emp object on save", OLD_EMP_BUILD, NEW_EMP_BUILD),
    ("Hire-transfer-missing-fields fix: add the 3 new fields to the dual-write patch", OLD_PATCH, NEW_PATCH),
]

if __name__ == "__main__":
    apply_edits(EDITS)
