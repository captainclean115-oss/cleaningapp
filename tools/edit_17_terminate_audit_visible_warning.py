#!/usr/bin/env python3
"""Terminate flow fix (C) -- terminateEmployee() now reports whether
its own audit_log write failed (auditFailed: true/false) instead of
only console.warn-ing it, so the manager-facing caller
(confirmTerminateEmployee) can show a VISIBLE warning. The termination
itself still isn't blocked by an audit failure -- it already happened
by this point -- this only makes the failure loud instead of silent.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  try {
    await _auditSupplement('terminated', 'employee', employeeId, {
      reason: reason, notes: notes || null, eligible_for_rehire: eligibleForRehire,
      terminated_at: date, terminated_by: currentUserId, future_assignments_removed: removedCount
    });
  } catch (e) { console.warn('[terminateEmployee] audit log write failed (non-fatal)', e); }

  return { removedCount: removedCount };"""

NEW = """  var auditFailed = false;
  try {
    await _auditSupplement('terminated', 'employee', employeeId, {
      reason: reason, notes: notes || null, eligible_for_rehire: eligibleForRehire,
      terminated_at: date, terminated_by: currentUserId, future_assignments_removed: removedCount
    });
  } catch (e) {
    console.warn('[terminateEmployee] audit log write failed (non-fatal)', e);
    auditFailed = true;
  }

  return { removedCount: removedCount, auditFailed: auditFailed };"""

EDITS = [("terminateEmployee: report audit failure instead of only console.warn", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
