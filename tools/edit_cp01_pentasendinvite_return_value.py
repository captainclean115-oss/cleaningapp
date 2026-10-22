#!/usr/bin/env python3
"""Claire portal-links feature, step 1: pentaSendInvite is reused (not
copied) by Claire's new send_portal_invite tool. The Staff screen's
button onclick handler ignores a return value, so this is a purely
additive change: every existing side effect (DOM update via
_renderInviteResult, the 60s/double-click guards, the duplicate-phone
check, the alerts) is preserved byte-for-byte -- each bare `return;` now
returns a small structured result object instead, so a caller that
DOES care (Claire) can inspect what happened without a second
implementation of any of this logic.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD = """  async function pentaSendInvite(rosterId) {
    // Double-click guard: set the flag SYNCHRONOUSLY, before any await,
    // so two back-to-back clicks (both still running synchronously when
    // the second one starts) can't both pass this check -- an async
    // function's body runs synchronously up to its first await, so a
    // flag set any later than this would let a true double-click race
    // right through it. Everything else lives inside one try/finally so
    // EVERY exit path (an early return, a thrown error, or the normal
    // end) clears the flag exactly once -- no return statement has to
    // remember to reset it itself.
    if (_inviteInFlight[rosterId]) return;
    _inviteInFlight[rosterId] = true;
    try {
      var lastSent = _inviteLastSentAt[rosterId];
      if (lastSent && (Date.now() - lastSent) < 60000) {
        var waitSec = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
        _renderInviteResult(rosterId, '<span style="color:var(--amber)">Please wait ' + waitSec + 's before resending.</span>');
        return;
      }

      var resolved;
      try {
        resolved = await _resolveEmployeeByRoster(rosterId);
      } catch (e) {
        alert('Send Invite failed (resolver crashed):\\n' + (e && e.message));
        console.error('[pentaSendInvite] resolver crash', e);
        return;
      }

      if (resolved.error) {
        var err = resolved.error;
        var detail;
        switch (err.kind) {
          case 'not_in_cache':
            detail = 'Employee not found in Supabase.\\n\\n' + err.msg + '\\n\\nIf this is a new employee, the backfill may not have run on this device yet. Try signing out and back in.';
            break;
          case 'list_threw':
          case 'list_threw_2':
          case 'hydrate_threw':
          case 'rehydrate_threw':
            detail = 'Could not load employees from Supabase.\\n\\n' + err.msg + '\\n\\nThis is usually an auth/session issue. Sign out and back in.';
            break;
          case 'list_not_array':
            detail = 'Employees query returned unexpected data. Sign out and back in.\\n\\n' + err.msg;
            break;
          case 'facade_missing':
            detail = 'PentaEmployees facade did not load. Reload the page.';
            break;
          default:
            detail = 'Unexpected error: ' + (err.msg || JSON.stringify(err));
        }
        alert('Send Invite failed.\\n\\n' + detail);
        console.error('[pentaSendInvite]', err);
        return;
      }

      var emp = resolved.employee;
      if (!emp.phone) {
        _renderInviteResult(rosterId, '<span style="color:var(--red)">No phone number on file for ' + (emp.first_name || 'this employee') + '. Add one in the Staff edit form first.</span>');
        return;
      }
      // Phone + password login feature: block the invite if this phone
      // is shared with another ACTIVE employee -- phone login/reset
      // need it to uniquely resolve an account for invites going
      // forward.
      try {
        var _normInv = String(emp.phone || '').replace(/\\D/g, '');
        if (_normInv.length === 11 && _normInv[0] === '1') _normInv = _normInv.slice(1);
        if (_normInv.length === 10 && window.PentaEmployees && window.PentaEmployees.listSync) {
          var _dupOwner = window.PentaEmployees.listSync().find(function (e) {
            if (!e || e.id === emp.id || e.status !== 'active') return false;
            var n2 = String(e.phone || '').replace(/\\D/g, '');
            if (n2.length === 11 && n2[0] === '1') n2 = n2.slice(1);
            return n2.length === 10 && n2 === _normInv;
          });
          if (_dupOwner) {
            _renderInviteResult(rosterId, '<span style="color:var(--red)">' + (emp.first_name || 'This employee') + '\\'s phone number is shared with ' + (_dupOwner.first_name || 'another active employee') + '. Fix one of their phone numbers first.</span>');
            return;
          }
        }
      } catch (e) { console.warn('[pentaSendInvite] duplicate-phone check failed (non-fatal, proceeding)', e); }

      var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
      if (!sb) {
        alert('Supabase client not ready. Reload the page.');
        return;
      }

      _renderInviteResult(rosterId, '<span style="color:var(--muted)">Sending…</span>');
      try {
        var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id } });
        _inviteLastSentAt[rosterId] = Date.now();
        if (res.error || !res.data || !res.data.success) {
          var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'Could not send the invite.';
          _renderInviteResult(rosterId,
            '<span style="color:var(--red)">' + _adminEsc(reason) + '</span>'
            + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
          return;
        }
        var sentTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        _renderInviteResult(rosterId, '<span style="color:var(--green)">Sent to ' + _maskPhone(emp.phone) + ' at ' + sentTime + '.</span>');
      } catch (e) {
        _renderInviteResult(rosterId,
          '<span style="color:var(--red)">Network error -- could not reach the server.</span>'
          + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
        console.error('[pentaSendInvite] send-invite call threw', e);
      }
    } finally {
      _inviteInFlight[rosterId] = false;
    }
  }"""

NEW = """  async function pentaSendInvite(rosterId) {
    // Double-click guard: set the flag SYNCHRONOUSLY, before any await,
    // so two back-to-back clicks (both still running synchronously when
    // the second one starts) can't both pass this check -- an async
    // function's body runs synchronously up to its first await, so a
    // flag set any later than this would let a true double-click race
    // right through it. Everything else lives inside one try/finally so
    // EVERY exit path (an early return, a thrown error, or the normal
    // end) clears the flag exactly once -- no return statement has to
    // remember to reset it itself.
    //
    // Claire portal-links feature: every exit path now returns a small
    // structured result ({ ok, reason, maskedPhone }) in ADDITION to its
    // existing side effects (unchanged) -- the Staff screen's button
    // onclick handler still just calls this and ignores the return
    // value, but Claire's send_portal_invite tool reuses this exact
    // function (same 60s/double-click/duplicate-phone guards, same
    // Edge Function call) instead of a second copy, and reads the
    // return value to report back and to write its audit row.
    if (_inviteInFlight[rosterId]) return { ok: false, reason: 'already_sending' };
    _inviteInFlight[rosterId] = true;
    try {
      var lastSent = _inviteLastSentAt[rosterId];
      if (lastSent && (Date.now() - lastSent) < 60000) {
        var waitSec = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
        _renderInviteResult(rosterId, '<span style="color:var(--amber)">Please wait ' + waitSec + 's before resending.</span>');
        return { ok: false, reason: 'Please wait ' + waitSec + 's before resending.' };
      }

      var resolved;
      try {
        resolved = await _resolveEmployeeByRoster(rosterId);
      } catch (e) {
        alert('Send Invite failed (resolver crashed):\\n' + (e && e.message));
        console.error('[pentaSendInvite] resolver crash', e);
        return { ok: false, reason: 'Resolver crashed: ' + ((e && e.message) || String(e)) };
      }

      if (resolved.error) {
        var err = resolved.error;
        var detail;
        switch (err.kind) {
          case 'not_in_cache':
            detail = 'Employee not found in Supabase.\\n\\n' + err.msg + '\\n\\nIf this is a new employee, the backfill may not have run on this device yet. Try signing out and back in.';
            break;
          case 'list_threw':
          case 'list_threw_2':
          case 'hydrate_threw':
          case 'rehydrate_threw':
            detail = 'Could not load employees from Supabase.\\n\\n' + err.msg + '\\n\\nThis is usually an auth/session issue. Sign out and back in.';
            break;
          case 'list_not_array':
            detail = 'Employees query returned unexpected data. Sign out and back in.\\n\\n' + err.msg;
            break;
          case 'facade_missing':
            detail = 'PentaEmployees facade did not load. Reload the page.';
            break;
          default:
            detail = 'Unexpected error: ' + (err.msg || JSON.stringify(err));
        }
        alert('Send Invite failed.\\n\\n' + detail);
        console.error('[pentaSendInvite]', err);
        return { ok: false, reason: detail };
      }

      var emp = resolved.employee;
      if (!emp.phone) {
        _renderInviteResult(rosterId, '<span style="color:var(--red)">No phone number on file for ' + (emp.first_name || 'this employee') + '. Add one in the Staff edit form first.</span>');
        return { ok: false, employeeId: emp.id, reason: 'No phone number on file.' };
      }
      // Phone + password login feature: block the invite if this phone
      // is shared with another ACTIVE employee -- phone login/reset
      // need it to uniquely resolve an account for invites going
      // forward.
      try {
        var _normInv = String(emp.phone || '').replace(/\\D/g, '');
        if (_normInv.length === 11 && _normInv[0] === '1') _normInv = _normInv.slice(1);
        if (_normInv.length === 10 && window.PentaEmployees && window.PentaEmployees.listSync) {
          var _dupOwner = window.PentaEmployees.listSync().find(function (e) {
            if (!e || e.id === emp.id || e.status !== 'active') return false;
            var n2 = String(e.phone || '').replace(/\\D/g, '');
            if (n2.length === 11 && n2[0] === '1') n2 = n2.slice(1);
            return n2.length === 10 && n2 === _normInv;
          });
          if (_dupOwner) {
            var _dupReason = (emp.first_name || 'This employee') + '\\'s phone number is shared with ' + (_dupOwner.first_name || 'another active employee') + '. Fix one of their phone numbers first.';
            _renderInviteResult(rosterId, '<span style="color:var(--red)">' + _dupReason + '</span>');
            return { ok: false, employeeId: emp.id, reason: _dupReason };
          }
        }
      } catch (e) { console.warn('[pentaSendInvite] duplicate-phone check failed (non-fatal, proceeding)', e); }

      var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
      if (!sb) {
        alert('Supabase client not ready. Reload the page.');
        return { ok: false, employeeId: emp.id, reason: 'Supabase client not ready. Reload the page.' };
      }

      _renderInviteResult(rosterId, '<span style="color:var(--muted)">Sending…</span>');
      try {
        var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id } });
        _inviteLastSentAt[rosterId] = Date.now();
        if (res.error || !res.data || !res.data.success) {
          var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'Could not send the invite.';
          _renderInviteResult(rosterId,
            '<span style="color:var(--red)">' + _adminEsc(reason) + '</span>'
            + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
          return { ok: false, employeeId: emp.id, reason: reason };
        }
        var sentTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        _renderInviteResult(rosterId, '<span style="color:var(--green)">Sent to ' + _maskPhone(emp.phone) + ' at ' + sentTime + '.</span>');
        return { ok: true, employeeId: emp.id, maskedPhone: _maskPhone(emp.phone), sentTime: sentTime };
      } catch (e) {
        _renderInviteResult(rosterId,
          '<span style="color:var(--red)">Network error -- could not reach the server.</span>'
          + '<button type="button" onclick="copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, "\\\\'") + '\\')" style="display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer">Copy invite link</button>');
        console.error('[pentaSendInvite] send-invite call threw', e);
        return { ok: false, employeeId: emp.id, reason: 'Network error -- could not reach the server.' };
      }
    } finally {
      _inviteInFlight[rosterId] = false;
    }
  }"""

apply_edits([
    ("pentaSendInvite: return a structured result at every exit path", OLD, NEW),
])
