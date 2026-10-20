#!/usr/bin/env python3
"""Portal-hours-match-manager fix -- update renderHoursTable's call
site to match resolveEmployeeDayHours's new signature (real Date `d`
instead of the pre-computed `dk` string, which the function now
derives internally via dateKey(d)).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "renderHoursTable: pass d (not dk) to resolveEmployeeDayHours",
        "const _rd = resolveEmployeeDayHours(emp.id, dk, i, weekHours, empHoursMap);",
        "const _rd = resolveEmployeeDayHours(emp.id, d, i, weekHours, empHoursMap);",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
