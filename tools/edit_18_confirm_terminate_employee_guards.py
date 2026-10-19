#!/usr/bin/env python3
"""Terminate flow fix (C) -- confirmTerminateEmployee():
  1. A visible confirm() when the chosen date is in the past (business
     timezone today), stating plainly what stays and what changes --
     per spec: "Setting a past termination date. Hours and assignments
     on or before [D] stay. She will no longer appear on days after [D]."
  2. A visible (toast, not just console) warning when terminateEmployee
     reports its own audit_log write failed -- the termination itself
     still succeeds and isn't blocked by this.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function confirmTerminateEmployee() {
  if (!_terminateEmployeeCtx) return;
  var errEl = document.getElementById('term-modal-error');
  errEl.style.display = 'none';
  var reason = document.getElementById('term-modal-reason').value;
  var date = document.getElementById('term-modal-date').value;
  var notes = document.getElementById('term-modal-notes').value.trim();
  var eligibleForRehire = document.getElementById('term-modal-rehire').checked;

  var btn = document.getElementById('term-modal-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Terminating…';
  try {
    await terminateEmployee(_terminateEmployeeCtx.uuid, { reason: reason, date: date, notes: notes, eligibleForRehire: eligibleForRehire });
    var source = _terminateEmployeeCtx.source;
    closeTerminateEmployeeModal();
    if (source === 'staff') {
      var sm = document.getElementById('staff-modal'); if (sm) sm.style.display = 'none';
      if (typeof renderStaffList === 'function') renderStaffList();
      if (typeof renderStaffSubview === 'function') renderStaffSubview();
    } else {
      var mm = document.getElementById('main-emp-modal'); if (mm) mm.style.display = 'none';
      if (typeof renderMainEmployees === 'function') renderMainEmployees();
    }
    if (typeof showToast === 'function') showToast('Employee terminated.', 'success');
  } catch (e) {
    errEl.textContent = (e && e.message) || 'Termination failed — try again.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm Termination';
  }
}"""

NEW = """async function confirmTerminateEmployee() {
  if (!_terminateEmployeeCtx) return;
  var errEl = document.getElementById('term-modal-error');
  errEl.style.display = 'none';
  var reason = document.getElementById('term-modal-reason').value;
  var date = document.getElementById('term-modal-date').value;
  var notes = document.getElementById('term-modal-notes').value.trim();
  var eligibleForRehire = document.getElementById('term-modal-rehire').checked;

  // Terminated-employee date-awareness fix: a backdated termination date
  // purges real, already-happened daily_assignments between D and
  // today (never anything dated today or earlier, per
  // unassignFutureForEmployee's own fix -- but D..yesterday is still
  // real history if D is far enough back). Confirm explicitly rather
  // than silently proceeding.
  try {
    var _tp = _bizTodayParts(_pentaBusinessTimezone());
    var _todayKey = _tp.y + '-' + String(_tp.m).padStart(2, '0') + '-' + String(_tp.d).padStart(2, '0');
    if (date && date < _todayKey) {
      var _pastMsg = 'Setting a past termination date (' + date + ').\\n\\nHours and assignments on or before ' + date + ' stay. She will no longer appear on days after ' + date + '.';
      if (!confirm(_pastMsg)) return;
    }
  } catch (e) { console.warn('[confirmTerminateEmployee] past-date confirm check failed (non-fatal)', e); }

  var btn = document.getElementById('term-modal-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Terminating…';
  try {
    var result = await terminateEmployee(_terminateEmployeeCtx.uuid, { reason: reason, date: date, notes: notes, eligibleForRehire: eligibleForRehire });
    var source = _terminateEmployeeCtx.source;
    closeTerminateEmployeeModal();
    if (source === 'staff') {
      var sm = document.getElementById('staff-modal'); if (sm) sm.style.display = 'none';
      if (typeof renderStaffList === 'function') renderStaffList();
      if (typeof renderStaffSubview === 'function') renderStaffSubview();
    } else {
      var mm = document.getElementById('main-emp-modal'); if (mm) mm.style.display = 'none';
      if (typeof renderMainEmployees === 'function') renderMainEmployees();
    }
    if (typeof showToast === 'function') showToast('Employee terminated.', 'success');
    // Terminate flow fix: the audit_log write is best-effort (the
    // termination itself already happened and must not be rolled back
    // over this) but its failure must be VISIBLE, not console-only.
    if (result && result.auditFailed) {
      if (typeof showToast === 'function') showToast('Employee terminated, but the audit log entry could not be saved -- let your developer know.', 'error');
      else alert('Employee terminated, but the audit log entry could not be saved -- let your developer know.');
    }
  } catch (e) {
    errEl.textContent = (e && e.message) || 'Termination failed — try again.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm Termination';
  }
}"""

EDITS = [("confirmTerminateEmployee: past-date confirm + visible audit-failure warning", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
