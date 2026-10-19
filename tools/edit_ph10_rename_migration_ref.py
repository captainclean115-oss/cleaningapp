#!/usr/bin/env python3
"""Published Hours feature. Migration renumbered 114 -> 115 (PR #196's
branch independently claimed 114 for a different file) -- update the two
comment references in index.html to match.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "Comment ref: Published Hours header",
        "// Published Hours (migrations/114_published_employee_hours.sql).",
        "// Published Hours (migrations/115_published_employee_hours.sql).",
    ),
    (
        "Comment ref: portal renderHours migration pointer",
        "    // migrations/114_published_employee_hours.sql and this feature's PR",
        "    // migrations/115_published_employee_hours.sql and this feature's PR",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
