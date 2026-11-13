#!/usr/bin/env python3
"""Weekend-hours-assignment-only fix. resolveEmployeeDayHours now calls
getUnifiedRoster(dk) FIRST (the new termination guard) -- this
equivalence test's sandbox never defined it, so every scenario would
now hit the "not on roster" early return and disagree with the OLD
formula. Default stub: employee 'e1' (what every scenario here uses)
is always on the roster, matching the real function's actual behavior
for a normal, non-terminated employee. Also drops isUnconfirmed from
the removed-field comment/destructure now that the field no longer
exists at all.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import _apply_edits as ae

ae.INDEX_HTML = os.path.join(os.path.dirname(__file__), "..", "tests", "resolve-employee-day-hours-equivalence.test.js")

OLD1 = """function buildSandbox(deps) {
  const sandbox = Object.assign({
    console,
    dateKey: function (d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    _hrsFmt12: function (x) {
      if (x == null) return '';
      if (x instanceof Date) return x.toISOString();
      return String(x);
    },
  }, deps);"""

NEW1 = """function buildSandbox(deps) {
  const sandbox = Object.assign({
    console,
    dateKey: function (d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    _hrsFmt12: function (x) {
      if (x == null) return '';
      if (x instanceof Date) return x.toISOString();
      return String(x);
    },
    // Weekend-hours-assignment-only fix: 'e1' (every scenario below)
    // is always on the roster -- termination-awareness itself is
    // covered separately in tests/hours-weekend-days.test.js.
    getUnifiedRoster: function () { return [{ id: 'e1' }]; },
  }, deps);"""

OLD2 = """  // The new function additionally returns startDate/endDate (needed by
  // the portal) and isUnconfirmed (hours-weekend-days fix) -- strip
  // those before comparing, since the OLD formula never had them;
  // every OTHER field must match byte-for-byte.
  const { startDate, endDate, isUnconfirmed, ...newComparable } = newResult;"""

NEW2 = """  // The new function additionally returns startDate/endDate (needed by
  // the portal) -- strip those before comparing, since the OLD formula
  // never had them; every OTHER field must match byte-for-byte.
  const { startDate, endDate, ...newComparable } = newResult;"""

EDITS = [
    ("Weekend-hours-assignment-only fix: stub getUnifiedRoster so e1 is always on roster", OLD1, NEW1),
    ("Weekend-hours-assignment-only fix: drop isUnconfirmed from the equivalence comparison strip", OLD2, NEW2),
]

if __name__ == "__main__":
    ae.apply_edits(EDITS)
