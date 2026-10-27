#!/usr/bin/env python3
"""Fix login button, step 1: renderStaffView().

Computes _showFixLogin (owner/admin only, employee has a login, not
terminated) alongside the existing teamColor/statusColor locals, then
conditionally includes the "Fix login" button + its inline result
panel inside the existing Penta Login section -- same section Send
Invite/Set Temp Password already live in, same styling convention.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD_GATE = """  const statusColor = emp.status === 'active' ? 'var(--green)' : emp.status === 'terminated' ? 'var(--red)' : 'var(--muted)';"""

NEW_GATE = """  const statusColor = emp.status === 'active' ? 'var(--green)' : emp.status === 'terminated' ? 'var(--red)' : 'var(--muted)';
  // Fix login button: owner/admin only, never manager/dispatcher/
  // employee/logged-out, and only for an employee who already has a
  // login and isn't terminated (repair-login-email itself enforces
  // the same server-side -- this is just UX, not the real security
  // boundary). Any failure here defaults to HIDDEN, never shown.
  let _showFixLogin = false;
  try {
    const _curRole = (typeof getCurrentAppRole === 'function') ? getCurrentAppRole() : null;
    _showFixLogin = (_curRole === 'owner' || _curRole === 'admin') && !!emp.auth_user_id && emp.status !== 'terminated';
  } catch (e) { _showFixLogin = false; }"""

OLD_SECTION = """    ${section('Penta Login', [
      `<div data-invite-chip data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="display:inline-flex;align-items:center;padding:6px 12px;background:var(--surface);border:1px solid var(--border);border-radius:20px;font-size:13px;margin-bottom:12px">…</div>`,
      `<div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" data-permission="send_employee_invites" data-permission-role="manager" data-action="send-invite" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Send Invite</button>
        <button type="button" data-permission="set_employee_password" data-permission-role="manager" data-action="set-temp-pw" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Set Temp Password</button>
      </div>`,
      `<div id="invite-send-result" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="font-size:12px;margin-top:8px;min-height:18px"></div>`
    ])}"""

NEW_SECTION = """    ${section('Penta Login', [
      `<div data-invite-chip data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="display:inline-flex;align-items:center;padding:6px 12px;background:var(--surface);border:1px solid var(--border);border-radius:20px;font-size:13px;margin-bottom:12px">…</div>`,
      `<div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" data-permission="send_employee_invites" data-permission-role="manager" data-action="send-invite" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Send Invite</button>
        <button type="button" data-permission="set_employee_password" data-permission-role="manager" data-action="set-temp-pw" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Set Temp Password</button>
      </div>`,
      `<div id="invite-send-result" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="font-size:12px;margin-top:8px;min-height:18px"></div>`,
      _showFixLogin
        ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
            <button type="button" id="fix-login-btn" data-action="fix-login" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="width:100%;padding:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Fix login</button>
            <div id="fix-login-panel" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="font-size:12px;margin-top:8px;display:none"></div>
          </div>`
        : ''
    ])}"""

apply_edits([
    ("renderStaffView: compute _showFixLogin (owner/admin, has login, not terminated)", OLD_GATE, NEW_GATE),
    ("Penta Login section: add the Fix login button + its result panel", OLD_SECTION, NEW_SECTION),
])
