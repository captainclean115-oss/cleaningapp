#!/usr/bin/env python3
"""Server-side invites feature. Visible result container under the Send
Invite / Set Temp Password buttons on the Staff detail view's "Penta
Login" section.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """      `<div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" data-permission="send_employee_invites" data-permission-role="manager" data-action="send-invite" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Send Invite</button>
        <button type="button" data-permission="set_employee_password" data-permission-role="manager" data-action="set-temp-pw" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Set Temp Password</button>
      </div>`
    ])}"""

NEW = """      `<div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" data-permission="send_employee_invites" data-permission-role="manager" data-action="send-invite" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Send Invite</button>
        <button type="button" data-permission="set_employee_password" data-permission-role="manager" data-action="set-temp-pw" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="flex:1;padding:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Set Temp Password</button>
      </div>`,
      `<div id="invite-send-result" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="font-size:12px;margin-top:8px;min-height:18px"></div>`
    ])}"""

EDITS = [("Staff detail view: invite-send-result container", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
