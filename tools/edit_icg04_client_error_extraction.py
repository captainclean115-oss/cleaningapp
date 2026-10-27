#!/usr/bin/env python3
"""Invite-collision guard, step 4: the Staff invite UI (single + bulk)
must show send-invite's own specific message (e.g. the new
phone_already_registered one), not a generic fallback.

Real bug found along the way: supabase-js's functions.invoke() throws
a FunctionsHttpError on any non-2xx response, with `data: null` -- the
actual JSON body (error/error_code) this function returns only lives,
UNPARSED, on error.context (the raw Response). The existing code
`(res.data && res.data.error) || (res.error && res.error.message)`
therefore falls through to the SDK's generic "Edge Function returned a
non-2xx status code" for EVERY non-2xx response send-invite has ever
returned (429 rate limit, 403, 400 missing phone, 500, 502, and now
409) -- not something this PR introduced, but something this PR's own
"show the specific message" requirement can't be met without fixing.
_extractInviteError() reads error.context.json() per the SDK's own
documented pattern to recover the real body.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

HELPER_OLD = """// =====================================================================
// Penta invite helpers — Sprint 4 Phase 4B (manager UI side)
// All take rosterId (legacy emp_roster id) and resolve to employees.id
// internally via PentaEmployees cache.
// =====================================================================
(function() {"""

HELPER_NEW = """// Invite-collision guard: shared by both the single-invite
// (pentaSendInvite) and bulk-invite (sendBulkInvites) call sites, so
// send-invite's own specific error message (rate limit, missing
// phone, phone_already_registered, etc.) is never swallowed into a
// generic one. supabase-js's functions.invoke() throws a
// FunctionsHttpError on any non-2xx response with `data: null` -- the
// real JSON body this function returned only lives, UNPARSED, on
// error.context (the raw Response); see the SDK's own doc comment for
// FunctionsHttpError, which shows this exact `error.context.json()`
// pattern.
async function _extractInviteError(res) {
  if (res.data && res.data.error) {
    return { message: res.data.error, code: res.data.error_code || null };
  }
  if (res.error && res.error.context && typeof res.error.context.json === 'function') {
    try {
      var body = await res.error.context.json();
      if (body && body.error) return { message: body.error, code: body.error_code || null };
    } catch (e) { /* non-JSON body -- fall through to the generic message below */ }
  }
  return { message: (res.error && res.error.message) || 'Could not send the invite.', code: null };
}

// =====================================================================
// Penta invite helpers — Sprint 4 Phase 4B (manager UI side)
// All take rosterId (legacy emp_roster id) and resolve to employees.id
// internally via PentaEmployees cache.
// =====================================================================
(function() {"""

SINGLE_OLD = """        var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id } });
        _inviteLastSentAt[rosterId] = Date.now();
        if (res.error || !res.data || !res.data.success) {
          var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'Could not send the invite.';
          _renderInviteResult(rosterId,
            '<span style="color:var(--red)">' + _adminEsc(reason) + '</span>'
            + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
          return;
        }"""

SINGLE_NEW = """        var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id } });
        _inviteLastSentAt[rosterId] = Date.now();
        if (res.error || !res.data || !res.data.success) {
          var extracted = await _extractInviteError(res);
          _renderInviteResult(rosterId,
            '<span style="color:var(--red)">' + _adminEsc(extracted.message) + '</span>'
            + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
          return;
        }"""

BULK_OLD = """      var res = await sb.functions.invoke('send-invite', { body: { employee_id: empId } });
      if (res.error || !res.data || !res.data.success) {
        var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'unknown error';
        results.push({ name: name, ok: false, reason: reason });
      } else {
        results.push({ name: name, ok: true });
      }"""

BULK_NEW = """      var res = await sb.functions.invoke('send-invite', { body: { employee_id: empId } });
      if (res.error || !res.data || !res.data.success) {
        var extracted = await _extractInviteError(res);
        results.push({ name: name, ok: false, reason: extracted.message });
      } else {
        results.push({ name: name, ok: true });
      }"""

apply_edits([
    ("insert shared _extractInviteError() helper before the invite-helpers IIFE", HELPER_OLD, HELPER_NEW),
    ("pentaSendInvite: use _extractInviteError instead of the generic fallback", SINGLE_OLD, SINGLE_NEW),
    ("sendBulkInvites: use _extractInviteError instead of the generic fallback", BULK_OLD, BULK_NEW),
])
