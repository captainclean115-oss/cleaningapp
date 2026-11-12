#!/usr/bin/env python3
"""Payroll report simplification -- no silent failures (part 2).

Appends the visible "ADMIN/OFFICE SECTION FAILED TO LOAD" line (when
adminSectionError got set, edit_pr03) to the text report only -- never
to the CSV, which stays strictly the two clean columns.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    textLines.push('');
    textLines.push(SEP_HEAVY);
    textLines.push('  Total hours: ' + grandHours.toFixed(2));
    textLines.push(SEP_HEAVY);
  }

  return {"""

NEW = """    textLines.push('');
    textLines.push(SEP_HEAVY);
    textLines.push('  Total hours: ' + grandHours.toFixed(2));
    textLines.push(SEP_HEAVY);
  }
  if (adminSectionError) {
    textLines.push('');
    textLines.push('  ADMIN/OFFICE SECTION FAILED TO LOAD: ' + adminSectionError);
  }

  return {"""

EDITS = [("Payroll report simplification: visible ADMIN/OFFICE SECTION FAILED TO LOAD line", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
