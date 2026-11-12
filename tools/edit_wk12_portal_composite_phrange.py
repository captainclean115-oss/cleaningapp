#!/usr/bin/env python3
"""Hours-weekend-days fix. Portal renderHours()'s composite accumulator
(hardcoded 5-element arrays) and the published_employee_hours query's
end-of-week bound (days[4]) -- both still assumed a 5-day week.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """  var composite = { days: [0,0,0,0,0], starts: [null,null,null,null,null], ends: [null,null,null,null,null], lunch: [null,null,null,null,null], status: [null,null,null,null,null], total: 0 };"""

NEW1 = """  var composite = { days: days.map(function () { return 0; }), starts: days.map(function () { return null; }), ends: days.map(function () { return null; }), lunch: days.map(function () { return null; }), status: days.map(function () { return null; }), total: 0 };"""

OLD2 = """    var _phMon = dateKey(days[0]), _phFri = dateKey(days[4]);"""

NEW2 = """    var _phMon = dateKey(days[0]), _phFri = dateKey(days[days.length - 1]);"""

EDITS = [
    ("Hours-weekend-days fix: portal composite accumulator sized to the real week length", OLD1, NEW1),
    ("Hours-weekend-days fix: portal published-hours query end-of-week bound uses the real last day", OLD2, NEW2),
]

if __name__ == "__main__":
    apply_edits(EDITS)
