#!/usr/bin/env python3
"""Salary amount/period follow-up -- the EXISTING pay_type persistence
test (from PR #195) now fails: saveStaffEmployee's real body references
two new bare-global helpers (_parseSalaryAmountInput, used by its
Save-time validation, and _staffSaveSalaryFields, the isolated write)
that this test's sandbox doesn't define. `typeof` on an undefined
identifier doesn't throw, so the validation's own
`typeof _parseSalaryAmountInput === 'function'` guard quietly took the
"missing" fallback branch and alert+returned before any write ever
happened -- a real safety behavior in production (never silently skip
validation), but it masks this test's actual pay_type assertions since
none of its 4 cases ever touch the new salary fields. Add minimal,
realistic mocks so those 4 pre-existing cases exercise the real
dual-write patch again, same as before this feature existed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

INDEX_HTML_OVERRIDE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "tests", "salaried-admin-staff-modal-persistence.test.js")

EDITS = [
    (
        "add _parseSalaryAmountInput + _staffSaveSalaryFields mocks to the test sandbox",
        """    getStaffList: () => staffList,
    switchEmployeeWorkType: (uuid, newWorkType) => { calls.push(['switchEmployeeWorkType', uuid, newWorkType]); return Promise.resolve({ removedCount: 0 }); },
    closeStaffModal: () => calls.push(['closeStaffModal']),
    renderStaffList: () => calls.push(['renderStaffList']),
  };""",
        """    getStaffList: () => staffList,
    switchEmployeeWorkType: (uuid, newWorkType) => { calls.push(['switchEmployeeWorkType', uuid, newWorkType]); return Promise.resolve({ removedCount: 0 }); },
    closeStaffModal: () => calls.push(['closeStaffModal']),
    renderStaffList: () => calls.push(['renderStaffList']),
    // Salary amount/period (migration 114 follow-up) -- real bare-global
    // helpers saveStaffEmployee's body now calls. None of this file's 4
    // cases populate a salary amount/period input, so the real parser's
    // "blank is valid" behavior is all that's needed here; the isolated
    // write itself is covered by its own dedicated test file.
    _parseSalaryAmountInput: (raw) => {
      var s = String(raw == null ? '' : raw).trim();
      if (s === '') return { ok: true, value: null };
      var cleaned = s.replace(/^\\$/, '').replace(/,/g, '').trim();
      if (!/^\\d+(\\.\\d+)?$/.test(cleaned)) return { ok: false, error: 'Salary amount must be a number.' };
      return { ok: true, value: Math.round(parseFloat(cleaned) * 100) / 100 };
    },
    _staffSaveSalaryFields: (id, empName, oldAmt, oldPer, newAmt, newPer) => {
      calls.push(['_staffSaveSalaryFields', id, oldAmt, oldPer, newAmt, newPer]);
      return Promise.resolve();
    },
  };""",
    ),
]

if __name__ == "__main__":
    import _apply_edits
    _apply_edits.INDEX_HTML = INDEX_HTML_OVERRIDE
    apply_edits(EDITS)
