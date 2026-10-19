#!/usr/bin/env python3
"""Hard Delete fix (D):
  1. _renderDeleteEmployeeCounts now also counts manual_hour_overrides,
     lunch_breaks, reward_redemptions, reward_submissions (the pre-
     delete check previously missed manual_hour_overrides entirely --
     an Admin/Office employee with months of hand-entered hours and
     nothing in the four originally-checked tables showed "looks safe
     to delete").
  2. The counting logic is factored into _deleteEmployeeHistoryCounts(),
     called from BOTH the UI (_renderDeleteEmployeeCounts) and the
     write path itself (confirmDeleteEmployee) -- so a stale screen (a
     modal left open while history accumulates elsewhere) can't bypass
     the gate by skipping straight to the confirm click.
  3. The Delete button is now actually disabled when any real history
     exists (it was never disabled before -- the red warning text was
     copy only), showing "This employee has history. Use Terminate
     instead." Hard delete stays available only for zero-history
     records.
  4. confirmDeleteEmployee re-checks the SAME counts before calling the
     RPC and refuses even if the button was somehow still enabled.
  5. A best-effort audit_log write (employee name, id, counts) fires
     before the RPC; its failure shows a visible warning, not just a
     console line -- the delete itself is NOT blocked by an audit
     failure (nothing is left to roll back yet at that point, unlike
     terminate's audit-after-the-fact case).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_COUNTS_FN = """async function _renderDeleteEmployeeCounts(uuid, hasAuthAccount) {
  var countsEl = document.getElementById('del-emp-counts');
  var btn = document.getElementById('del-emp-confirm-btn');
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { countsEl.textContent = 'Could not check associated data — Supabase not ready.'; return; }
  var checks = [
    ['Team assignments', 'daily_assignments'],
    ['Hours entries', 'time_entries'],
    ['Reward points records', 'reward_ledger'],
    ['Submitted forms', 'forms'],
  ];
  try {
    var results = await Promise.all(checks.map(function (c) {
      return sb.from(c[1]).select('id', { count: 'exact', head: true }).eq('employee_id', uuid)
        .then(function (r) { return { label: c[0], count: (r && r.count) || 0 }; })
        .catch(function () { return { label: c[0], count: null }; });
    }));
    var hiredRes = await sb.from('job_applications').select('id', { count: 'exact', head: true }).eq('hired_employee_id', uuid);
    var hiredCount = (hiredRes && hiredRes.count) || 0;

    var totalReal = results.reduce(function (s, r) { return s + (r.count || 0); }, 0);
    var rowsHtml = results.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="color:var(--muted)">' + r.label + '</span><span style="font-weight:600;color:' + (r.count ? 'var(--red)' : 'var(--muted)') + '">' + (r.count == null ? '?' : r.count) + '</span></div>';
    }).join('');
    var hiredNote = hiredCount > 0
      ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--amber)">Linked to ' + hiredCount + ' job application' + (hiredCount === 1 ? '' : 's') + ' — the link will be cleared, the application itself is kept.</div>'
      : '';
    // PR #157 -- deleting also removes their login account (auth.users)
    // now, not just the employees row, so re-inviting the same email
    // later doesn't hit a stale-identity conflict. Worth disclosing
    // explicitly since it's a distinct kind of deletion from the app-data
    // counts above.
    var authNote = hasAuthAccount
      ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--amber)">Has a login account — it will be deleted too, freeing up their email/phone for a future re-invite.</div>'
      : '';
    countsEl.innerHTML = rowsHtml + hiredNote + authNote
      + (totalReal === 0 ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--green)">No associated activity found — looks safe to delete.</div>'
        : '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--red);font-weight:600">This employee has real associated data. Consider Terminate Employee instead unless you\\'re sure this is a test record.</div>');
    btn.disabled = false; btn.textContent = 'Delete Permanently'; btn.style.opacity = '1';
  } catch (e) {
    countsEl.textContent = 'Could not check associated data: ' + ((e && e.message) || 'unknown error');
  }
}"""

NEW_COUNTS_FN = """// Hard Delete fix: the counted tables, shared between the UI
// (_renderDeleteEmployeeCounts) and the write-path gate
// (confirmDeleteEmployee) so both always agree. Originally missed
// manual_hour_overrides/lunch_breaks/reward_redemptions/
// reward_submissions entirely -- an employee with months of
// hand-entered hours and nothing in the other four tables showed
// "looks safe to delete."
var _DELETE_EMPLOYEE_HISTORY_CHECKS = [
  ['Team assignments', 'daily_assignments'],
  ['Hours entries', 'time_entries'],
  ['Manual hour overrides', 'manual_hour_overrides'],
  ['Lunch breaks', 'lunch_breaks'],
  ['Reward points records', 'reward_ledger'],
  ['Reward redemptions', 'reward_redemptions'],
  ['Reward submissions', 'reward_submissions'],
  ['Submitted forms', 'forms'],
];

// Hard Delete fix: single source of truth for "does this employee have
// real history" -- called from the UI AND re-checked at the actual
// write path, so a stale modal (left open while history accumulates
// elsewhere) can never bypass the gate.
async function _deleteEmployeeHistoryCounts(uuid) {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) throw new Error('Could not check associated data — Supabase not ready.');
  var results = await Promise.all(_DELETE_EMPLOYEE_HISTORY_CHECKS.map(function (c) {
    return sb.from(c[1]).select('id', { count: 'exact', head: true }).eq('employee_id', uuid)
      .then(function (r) { return { label: c[0], count: (r && r.count) || 0 }; })
      .catch(function () { return { label: c[0], count: null }; });
  }));
  var totalReal = results.reduce(function (s, r) { return s + (r.count || 0); }, 0);
  return { results: results, totalReal: totalReal };
}

async function _renderDeleteEmployeeCounts(uuid, hasAuthAccount) {
  var countsEl = document.getElementById('del-emp-counts');
  var btn = document.getElementById('del-emp-confirm-btn');
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { countsEl.textContent = 'Could not check associated data — Supabase not ready.'; return; }
  try {
    var counts = await _deleteEmployeeHistoryCounts(uuid);
    var results = counts.results;
    var totalReal = counts.totalReal;
    var hiredRes = await sb.from('job_applications').select('id', { count: 'exact', head: true }).eq('hired_employee_id', uuid);
    var hiredCount = (hiredRes && hiredRes.count) || 0;

    var rowsHtml = results.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;padding:3px 0"><span style="color:var(--muted)">' + r.label + '</span><span style="font-weight:600;color:' + (r.count ? 'var(--red)' : 'var(--muted)') + '">' + (r.count == null ? '?' : r.count) + '</span></div>';
    }).join('');
    var hiredNote = hiredCount > 0
      ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--amber)">Linked to ' + hiredCount + ' job application' + (hiredCount === 1 ? '' : 's') + ' — the link will be cleared, the application itself is kept.</div>'
      : '';
    // PR #157 -- deleting also removes their login account (auth.users)
    // now, not just the employees row, so re-inviting the same email
    // later doesn't hit a stale-identity conflict. Worth disclosing
    // explicitly since it's a distinct kind of deletion from the app-data
    // counts above.
    var authNote = hasAuthAccount
      ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--amber)">Has a login account — it will be deleted too, freeing up their email/phone for a future re-invite.</div>'
      : '';
    countsEl.innerHTML = rowsHtml + hiredNote + authNote
      + (totalReal === 0 ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--green)">No associated activity found — looks safe to delete.</div>'
        : '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--red);font-weight:600">This employee has history. Use Terminate instead.</div>');
    // Hard Delete fix: actually gate the button on real history --
    // before this fix it was always re-enabled regardless of the
    // counts above; the red warning text was copy only, not a block.
    btn.disabled = totalReal > 0;
    btn.textContent = totalReal > 0 ? 'Use Terminate Instead' : 'Delete Permanently';
    btn.style.opacity = totalReal > 0 ? '0.5' : '1';
  } catch (e) {
    countsEl.textContent = 'Could not check associated data: ' + ((e && e.message) || 'unknown error');
  }
}"""

OLD_CONFIRM_FN = """async function confirmDeleteEmployee() {
  if (!_deleteEmployeeCtx) return;
  var errEl = document.getElementById('del-emp-error');
  errEl.style.display = 'none';
  var btn = document.getElementById('del-emp-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (sb) {
      await sb.from('job_applications').update({ hired_employee_id: null }).eq('hired_employee_id', _deleteEmployeeCtx.uuid);
    }
    if (!window.PentaEmployees || !window.PentaEmployees.hardDelete) throw new Error('Delete is unavailable right now — refresh and try again.');
    await window.PentaEmployees.hardDelete(_deleteEmployeeCtx.uuid);
    var source = _deleteEmployeeCtx.source;
    closeDeleteEmployeeModal();"""

NEW_CONFIRM_FN = """async function confirmDeleteEmployee() {
  if (!_deleteEmployeeCtx) return;
  var errEl = document.getElementById('del-emp-error');
  errEl.style.display = 'none';
  var btn = document.getElementById('del-emp-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    // Hard Delete fix: re-check history at the ACTUAL write path, not
    // just the UI -- a stale modal (left open while history
    // accumulates elsewhere) must not be able to bypass the gate by
    // reaching this function with a disabled-in-appearance-only button.
    var _gateCounts = await _deleteEmployeeHistoryCounts(_deleteEmployeeCtx.uuid);
    if (_gateCounts.totalReal > 0) {
      throw new Error('This employee has history. Use Terminate instead.');
    }
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (sb) {
      await sb.from('job_applications').update({ hired_employee_id: null }).eq('hired_employee_id', _deleteEmployeeCtx.uuid);
    }
    if (!window.PentaEmployees || !window.PentaEmployees.hardDelete) throw new Error('Delete is unavailable right now — refresh and try again.');
    // Hard Delete fix: best-effort audit_log write BEFORE the RPC
    // (nothing destructive has happened yet at this point, unlike
    // terminate's audit-after-the-fact case) -- carries the employee's
    // name/id and the exact zero-history counts just confirmed. A
    // failure here shows a visible warning, not just a console line,
    // but does not block the delete itself.
    try {
      await _auditSupplement('deleted', 'employee', _deleteEmployeeCtx.uuid, {
        employee_name: _deleteEmployeeCtx.name, counts: _gateCounts.results
      });
    } catch (auditErr) {
      console.warn('[confirmDeleteEmployee] audit log write failed (non-fatal)', auditErr);
      if (typeof showToast === 'function') showToast('Proceeding with delete, but the audit log entry could not be saved -- let your developer know.', 'error');
      else alert('Proceeding with delete, but the audit log entry could not be saved -- let your developer know.');
    }
    await window.PentaEmployees.hardDelete(_deleteEmployeeCtx.uuid);
    var source = _deleteEmployeeCtx.source;
    closeDeleteEmployeeModal();"""

EDITS = [
    ("factor out + extend _deleteEmployeeHistoryCounts, gate the UI button", OLD_COUNTS_FN, NEW_COUNTS_FN),
    ("confirmDeleteEmployee: re-check the gate + audit write before the RPC", OLD_CONFIRM_FN, NEW_CONFIRM_FN),
]

if __name__ == "__main__":
    apply_edits(EDITS)
