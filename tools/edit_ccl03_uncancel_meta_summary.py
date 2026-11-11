#!/usr/bin/env python3
"""Claire cleanup PART 2: uncancel_clean classification + proposal summary."""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_META = """  cancel_clean:                  { gate: true,  sensitive: false },"""
NEW_META = """  cancel_clean:                  { gate: true,  sensitive: false },
  uncancel_clean:                { gate: true,  sensitive: false },"""

OLD_SUMMARY = """    case 'cancel_clean':
      return 'Cancel ' + (input.client || 'a client') + '\\'s clean' + (input.date ? ' on ' + input.date : '') + '.';"""
NEW_SUMMARY = """    case 'cancel_clean':
      return 'Cancel ' + (input.client || 'a client') + '\\'s clean' + (input.date ? ' on ' + input.date : '') + '.';
    case 'uncancel_clean':
      return 'Restore ' + (input.client || 'a client') + '\\'s cancelled clean' + (input.date ? ' on ' + input.date : '') + '.';"""

EDITS = [
    ("Claire cleanup PART 2: uncancel_clean in CLAIRE_TOOL_META (gated, non-sensitive)", OLD_META, NEW_META),
    ("Claire cleanup PART 2: uncancel_clean proposal summary", OLD_SUMMARY, NEW_SUMMARY),
]

if __name__ == "__main__":
    apply_edits(EDITS)
