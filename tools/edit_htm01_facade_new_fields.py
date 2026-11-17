#!/usr/bin/env python3
"""Hire-transfer-missing-fields fix -- PART 1. Wires 4 application
fields into the PentaEmployees facade's read/write mapping
(_TOROW_KNOWN_FIELDS, _toRow, _fromRow):

- preferred_language: the employees.preferred_language COLUMN already
  exists (an earlier migration added it) but nothing ever read or
  wrote it -- the hire code only ever derived the lossy culture_tag
  short-code from it. Wired through now so the applicant's own
  language selection is preserved verbatim, not just a 2-letter culture
  tag.
- has_reliable_transportation, prior_employer, earliest_start_date:
  brand new columns (migration 124) -- the application collects all
  three and the employee side had nowhere to put them at all.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_WHITELIST = """    // schedule preference
    prefTime: 1, preferred_start_time: 1,"""

NEW_WHITELIST = """    // schedule preference
    prefTime: 1, preferred_start_time: 1,
    // Hire-transfer-missing-fields fix: preferred_language (column
    // already existed, never wired in) + 3 new columns (migration 124)
    // the application collects with nowhere to land on the employee
    // side before this fix.
    preferred_language: 1, has_reliable_transportation: 1, prior_employer: 1, earliest_start_date: 1,"""

OLD_TOROW_TAIL = """    if (emp.emRel != null) row.emergency_contact_relationship = String(emp.emRel || '').trim() || null;
    if (emp.emergency_contact_relationship != null) row.emergency_contact_relationship = String(emp.emergency_contact_relationship || '').trim() || null;

    return row;
  }"""

NEW_TOROW_TAIL = """    if (emp.emRel != null) row.emergency_contact_relationship = String(emp.emRel || '').trim() || null;
    if (emp.emergency_contact_relationship != null) row.emergency_contact_relationship = String(emp.emergency_contact_relationship || '').trim() || null;

    // Hire-transfer-missing-fields fix: preferred_language (column
    // already existed, never wired in before this fix) + 3 new
    // columns (migration 124).
    if (emp.preferred_language != null) row.preferred_language = String(emp.preferred_language || '').trim() || null;
    if (emp.has_reliable_transportation != null) row.has_reliable_transportation = !!emp.has_reliable_transportation;
    if (emp.prior_employer != null) row.prior_employer = String(emp.prior_employer || '').trim() || null;
    if (emp.earliest_start_date != null) row.earliest_start_date = _normalizeDate(emp.earliest_start_date);

    return row;
  }"""

OLD_FROMROW_TAIL = """    if (row.emergency_contact_relationship != null) emp.emRel = row.emergency_contact_relationship;

    if (row.deleted_at != null) emp.deleted_at = row.deleted_at;"""

NEW_FROMROW_TAIL = """    if (row.emergency_contact_relationship != null) emp.emRel = row.emergency_contact_relationship;

    // Hire-transfer-missing-fields fix: preferred_language + 3 new
    // columns (migration 124) -- see _toRow's matching comment.
    if (row.preferred_language != null) emp.preferred_language = row.preferred_language;
    if (row.has_reliable_transportation != null) emp.has_reliable_transportation = row.has_reliable_transportation;
    if (row.prior_employer != null) emp.prior_employer = row.prior_employer;
    if (row.earliest_start_date != null) emp.earliest_start_date = row.earliest_start_date;

    if (row.deleted_at != null) emp.deleted_at = row.deleted_at;"""

EDITS = [
    ("Hire-transfer-missing-fields fix: whitelist the 4 new/newly-wired fields", OLD_WHITELIST, NEW_WHITELIST),
    ("Hire-transfer-missing-fields fix: _toRow writes the 4 fields", OLD_TOROW_TAIL, NEW_TOROW_TAIL),
    ("Hire-transfer-missing-fields fix: _fromRow reads the 4 fields back", OLD_FROMROW_TAIL, NEW_FROMROW_TAIL),
]

if __name__ == "__main__":
    apply_edits(EDITS)
