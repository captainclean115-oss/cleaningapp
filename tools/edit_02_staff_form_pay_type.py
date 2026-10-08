#!/usr/bin/env python3
"""Edit 2/N -- salaried Admin/Office feature.

Staff form: a "Pay Type" control (Hourly default / Salaried), reusing
the existing employees.pay_type column (employee_pay_type enum:
'hourly' | 'salary' -- no schema change). Hides/disables the hourly-
rate field specifically when the combination is Admin + Salaried
(isSalariedAdmin), not for salaried field employees -- their behavior
is explicitly out of scope and unchanged.

Also adds a "Salaried" badge to the Staff list (renderStaffList) for
the same combination.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "renderStaffList card: Salaried badge, hide the pay-rate chip for salaried Admin",
        """        <div style="font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px">
          <span style="color:${color};font-weight:600">${_teamName}</span>
          ${emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : ''}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
          <span data-invite-pill data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}"></span>""",
        """        <div style="font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px">
          <span style="color:${color};font-weight:600">${_teamName}</span>
          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? '<span style="color:#fbbf24;font-weight:700">Salaried</span>' : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
          <span data-invite-pill data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}"></span>""",
    ),
    (
        "renderStaffSubview card: same Salaried badge treatment (a second, separate Staff screen surface)",
        """        <div style="font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px">
          <span style="color:${color};font-weight:600">${_teamName}</span>
          ${emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : ''}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
        </div>
        ${emp.phone ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">📱 ${emp.phone}</div>` : ''}""",
        """        <div style="font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px">
          <span style="color:${color};font-weight:600">${_teamName}</span>
          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? '<span style="color:#fbbf24;font-weight:700">Salaried</span>' : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
        </div>
        ${emp.phone ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">📱 ${emp.phone}</div>` : ''}""",
    ),
    (
        "Staff form: add the Pay Type select + hint, wrap the Pay Rate field in an id",
        """      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Pay Rate ($/hr)</div><input type="number" id="staff-pay" step="0.25" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>
        <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Language</div>""",
        """      <div style="margin-bottom:14px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Pay Type</div>
        <select id="staff-pay-type" onchange="_staffToggleHourlyFieldsForPayType()" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none;appearance:none">
          <option value="hourly">Hourly (default)</option>
          <option value="salary">Salaried</option>
        </select>
        <div id="staff-pay-type-hint" style="display:none;font-size:11px;color:var(--amber);margin-top:5px">Salaried Admin/Office employees have a fixed pay rate and no hours tracked anywhere -- the hourly rate below doesn't apply.</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div id="staff-pay-rate-field"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Pay Rate ($/hr)</div><input type="number" id="staff-pay" step="0.25" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>
        <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Language</div>""",
    ),
    (
        "_staffToggleTeamFieldForWorkType: also re-evaluate the Pay Type combo when Work Type changes",
        """  var teamSel = document.getElementById('staff-team');
  if (teamSel) teamSel.disabled = isAdmin;
  if (hint) hint.style.display = isAdmin ? '' : 'none';
}

function openAddStaff() {""",
        """  var teamSel = document.getElementById('staff-team');
  if (teamSel) teamSel.disabled = isAdmin;
  if (hint) hint.style.display = isAdmin ? '' : 'none';
  // Switching Work Type can change whether the Admin+Salaried
  // combination applies (e.g. an already-salaried employee switching
  // to Admin should immediately hide the pay-rate field too).
  try { if (typeof _staffToggleHourlyFieldsForPayType === 'function') _staffToggleHourlyFieldsForPayType(); }
  catch (e) { console.warn('[_staffToggleTeamFieldForWorkType] pay-type re-check failed', e); }
}

// Salaried Admin/Office (follow-up to migration 113). Hides/disables
// the hourly Pay Rate field ONLY for the Admin+Salaried combination
// (isSalariedAdmin's own rule, re-read from the two form controls
// directly since nothing has been saved yet at this point) -- a
// salaried FIELD employee's pay-rate field is explicitly left alone,
// unchanged, per spec. Called by staff-pay-type's own onchange, and by
// _staffToggleTeamFieldForWorkType whenever Work Type changes too.
function _staffToggleHourlyFieldsForPayType() {
  var wtSel = document.getElementById('staff-work-type');
  var ptSel = document.getElementById('staff-pay-type');
  var payField = document.getElementById('staff-pay-rate-field');
  var hint = document.getElementById('staff-pay-type-hint');
  if (!ptSel) { console.warn('[_staffToggleHourlyFieldsForPayType] #staff-pay-type missing'); return; }
  var formIsSalariedAdmin = !!(wtSel && wtSel.value === 'admin' && ptSel.value === 'salary');
  if (payField) { payField.style.opacity = formIsSalariedAdmin ? '0.4' : '1'; payField.style.pointerEvents = formIsSalariedAdmin ? 'none' : ''; }
  var payInput = document.getElementById('staff-pay');
  if (payInput) payInput.disabled = formIsSalariedAdmin;
  if (hint) hint.style.display = formIsSalariedAdmin ? '' : 'none';
}

function openAddStaff() {""",
    ),
    (
        "openAddStaff: default Pay Type to hourly for new hires",
        "    set('staff-work-type', 'field'); // new hires default to a field team, never Admin\n    if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();",
        "    set('staff-work-type', 'field'); // new hires default to a field team, never Admin\n    set('staff-pay-type', 'hourly'); // new hires default to hourly, never salaried\n    if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();\n    if (typeof _staffToggleHourlyFieldsForPayType === 'function') _staffToggleHourlyFieldsForPayType();",
    ),
    (
        "openEditStaff: hydrate Pay Type from the real employee row",
        """  var _wtSel = document.getElementById('staff-work-type');
  if (_wtSel) _wtSel.value = (emp.work_type === 'admin') ? 'admin' : 'field';
  if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();""",
        """  var _wtSel = document.getElementById('staff-work-type');
  if (_wtSel) _wtSel.value = (emp.work_type === 'admin') ? 'admin' : 'field';
  var _ptSel = document.getElementById('staff-pay-type');
  if (_ptSel) _ptSel.value = (emp.pay_type === 'salary') ? 'salary' : 'hourly';
  if (typeof _staffToggleTeamFieldForWorkType === 'function') _staffToggleTeamFieldForWorkType();
  if (typeof _staffToggleHourlyFieldsForPayType === 'function') _staffToggleHourlyFieldsForPayType();""",
    ),
]

apply_edits(EDITS)
