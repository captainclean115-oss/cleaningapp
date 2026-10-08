#!/usr/bin/env python3
"""Salary amount/period follow-up -- bugfix found by the parse/format
test: the numeric regex in _parseSalaryAmountInput didn't allow a
leading '-', so a negative amount fell through to the generic
"must be a number" message instead of the intended, more specific
"Salary amount cannot be negative." Widen the regex to admit a leading
minus so the dedicated negative-number branch actually gets reached.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "widen numeric regex to admit a leading minus so the negative-specific message fires",
        """  var cleaned = s.replace(/^\\$/, '').replace(/,/g, '').trim();
  if (!/^\\d+(\\.\\d+)?$/.test(cleaned)) {
    return { ok: false, error: 'Salary amount must be a number (e.g. 13000 or 13,000.00) -- no letters or symbols other than a leading $ and commas.' };
  }""",
        """  var cleaned = s.replace(/^\\$/, '').replace(/,/g, '').trim();
  if (!/^-?\\d+(\\.\\d+)?$/.test(cleaned)) {
    return { ok: false, error: 'Salary amount must be a number (e.g. 13000 or 13,000.00) -- no letters or symbols other than a leading $ and commas.' };
  }""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
