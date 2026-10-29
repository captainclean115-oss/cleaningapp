#!/usr/bin/env python3
"""Claire portal-links update, step 1: fix the merge-introduced dangling
`reason` reference in pentaSendInvite (PR #205's collision-guard work
replaced the old synchronous `var reason = ...` line with the shared
async _extractInviteError() helper; Claire's branch, developed in
parallel, still returned `reason: reason` from that exact spot --
textually non-conflicting, so git merged both halves without
flagging it, but the variable it reads no longer exists).

Also updates pentaSendPasswordReset (which calls send-invite with
action:"reset" -- not request-password-reset, which is the unrelated
employee self-service "forgot password" flow) to use the SAME shared
_extractInviteError helper, so a collision refusal (or any other real
server reason) is reported verbatim instead of a generic message.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD_RESET_ERROR = """      try {
        var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id, action: 'reset' } });
        _resetLastSentAt[rosterId] = Date.now();
        if (res.error || !res.data || !res.data.success) {
          var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'Could not send the reset text.';
          return { ok: false, employeeId: emp.id, reason: reason };
        }"""

NEW_RESET_ERROR = """      try {
        var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id, action: 'reset' } });
        _resetLastSentAt[rosterId] = Date.now();
        if (res.error || !res.data || !res.data.success) {
          var extracted = await _extractInviteError(res);
          return { ok: false, employeeId: emp.id, reason: extracted.message, reasonCode: extracted.code };
        }"""

OLD_INVITE_ERROR = """        if (res.error || !res.data || !res.data.success) {
          var extracted = await _extractInviteError(res);
          _renderInviteResult(rosterId,
            '<span style="color:var(--red)">' + _adminEsc(extracted.message) + '</span>'
            + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
          return { ok: false, employeeId: emp.id, reason: reason };
        }"""

NEW_INVITE_ERROR = """        if (res.error || !res.data || !res.data.success) {
          var extracted = await _extractInviteError(res);
          _renderInviteResult(rosterId,
            '<span style="color:var(--red)">' + _adminEsc(extracted.message) + '</span>'
            + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
          return { ok: false, employeeId: emp.id, reason: extracted.message, reasonCode: extracted.code };
        }"""

apply_edits([
    ("pentaSendPasswordReset: use the shared _extractInviteError helper", OLD_RESET_ERROR, NEW_RESET_ERROR),
    ("pentaSendInvite: fix the dangling `reason` reference left by the merge, carry reasonCode forward", OLD_INVITE_ERROR, NEW_INVITE_ERROR),
])
