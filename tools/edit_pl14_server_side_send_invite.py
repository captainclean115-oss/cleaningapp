#!/usr/bin/env python3
"""Server-side invites feature. Replaces pentaSendInvite's client-side
token-generation + employee_invites insert + sms: deep-link modal with a
call to the new send-invite Edge Function -- the client never builds the
phone number or message text, never sees the link/token on success, and
no sms: link is ever shown for an invite again. pentaShowInviteSendModal
(the old sms:-link modal, no other callers) is removed entirely as dead
code rather than left orphaned.

Adds: an in-memory (not localStorage) double-click guard and a 60-second
resend guard, both keyed by rosterId; a visible per-row result ("Sent to
***-***-1234 at 3:42 PM" or a red plain-English failure); on failure, a
manager-only "Copy invite link" button that reads the token through the
SAME RLS the Staff screen already relies on (employee_invites_select:
owner/admin/manager) -- not through the Edge Function, which never
returns it.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  async function pentaSendInvite(rosterId) {
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
      alert('No phone number on file for ' + (emp.first_name || 'this employee') + '. Add a phone in the Staff edit form first.');
      return;
    }
    // Phone + password login feature: block the invite if this phone is
    // shared with another ACTIVE employee -- phone login/reset need it
    // to uniquely resolve an account for invites going forward.
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
          alert((emp.first_name || 'This employee') + '\\'s phone number is shared with ' + (_dupOwner.first_name || 'another active employee') + '. Fix one of their phone numbers in the Staff edit form before inviting -- phone sign-in needs each active employee to have her own number.');
          return;
        }
      }
    } catch (e) { console.warn('[pentaSendInvite] duplicate-phone check failed (non-fatal, proceeding)', e); }

    // Generate token + expiry
    var token, expires;
    try {
      token = await pentaGenerateInviteToken();
      expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    } catch (e) {
      alert('Could not generate invite token: ' + (e && e.message));
      return;
    }

    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) {
      alert('Supabase client not ready. Reload the page.');
      return;
    }

    var insertResult;
    try {
      insertResult = await sb.from('employee_invites').insert({
        business_id: emp.business_id,
        employee_id: emp.id,
        token: token,
        phone_sent_to: emp.phone,
        expires_at: expires
      });
    } catch (e) {
      alert('Could not create invite row: ' + (e && e.message));
      console.error('[pentaSendInvite] insert threw', e);
      return;
    }
    if (insertResult && insertResult.error) {
      alert('Could not create invite row.\\n\\n' + insertResult.error.message + '\\n\\nThis is usually an RLS/permissions issue.');
      console.error('[pentaSendInvite] insert error', insertResult.error);
      return;
    }

    var url = 'https://captainclean115-oss.github.io/cleaningapp/accept-invite.html?token=' + token;
    var body = 'Hi ' + (emp.first_name || 'there') + ', welcome to Penta! Set your password: ' + url + ' Link expires in 48 hours.';

    if (typeof pentaShowInviteSendModal === 'function') {
      pentaShowInviteSendModal(emp, body, url);
    } else {
      alert('Invite created but send modal helper missing. Token URL:\\n' + url);
    }
  }

  function pentaShowInviteSendModal(emp, smsBody, url) {
    var existing = document.getElementById('penta-invite-send-overlay');
    if (existing) existing.remove();

    var phone = String(emp.phone || '').replace(/\\D/g, '');
    if (phone.length === 10) phone = '1' + phone;
    var rcHref = 'sms:+' + phone + '&body=' + encodeURIComponent(smsBody);
    var safeBody = String(smsBody).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    var ov = document.createElement('div');
    ov.id = 'penta-invite-send-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:24px;';
    ov.innerHTML = ''
      + '<div style="max-width:440px;width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:16px;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif">'
      +   '<div style="font-size:18px;font-weight:700;margin-bottom:6px">Send invite to ' + (emp.first_name || '') + '</div>'
      +   '<div style="font-size:13px;color:var(--muted);margin-bottom:16px">Tap to open Messages with the SMS pre-filled, then hit Send.</div>'
      +   '<div style="background:var(--surface2);border-radius:10px;padding:12px;font-size:13px;line-height:1.4;margin-bottom:16px;white-space:pre-wrap;word-break:break-word">' + safeBody + '</div>'
      +   '<a href="' + rcHref + '" style="display:block;text-align:center;padding:14px;background:#FF7A00;color:#fff;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;margin-bottom:10px">📱 Open Messages</a>'
      +   '<div style="font-size:11px;color:var(--muted);text-align:center;margin-bottom:16px">Sending to ' + (emp.phone || '—') + '</div>'
      +   '<button type="button" id="penta-invite-send-close" style="width:100%;padding:12px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:14px;cursor:pointer">Close</button>'
      + '</div>';
    document.body.appendChild(ov);
    document.getElementById('penta-invite-send-close').addEventListener('click', function() { ov.remove(); });
  }
"""

NEW = """  // Server-side invites feature: in-memory (never localStorage) guards
  // against a double-click and against resending within 60 seconds.
  // Keyed by rosterId -- cleared on page reload, which is fine, this is
  // a UI-only speed bump, not a security control (the Edge Function has
  // its own real rate limit regardless).
  var _inviteInFlight = {};
  var _inviteLastSentAt = {};

  function _renderInviteResult(rosterId, html) {
    var el = document.querySelector('[id=\"invite-send-result\"][data-roster-id=\"' + CSS.escape(rosterId) + '\"]');
    if (el) el.innerHTML = html;
  }

  function _maskPhone(phone) {
    var digits = String(phone || '').replace(/\\D/g, '');
    var last4 = digits.slice(-4);
    return last4.length === 4 ? ('***-***-' + last4) : 'her phone';
  }

  // Manager-only fallback when the server send fails: reads the token
  // through the SAME RLS the rest of the Staff screen already relies on
  // (employee_invites_select: owner/admin/manager) -- send-invite itself
  // never returns the token, this is a separate, already-permitted read.
  async function copyInviteLink(employeeUuid, rosterId) {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) { alert('Not connected -- refresh and try again.'); return; }
    try {
      var res = await sb.from('employee_invites')
        .select('token, created_at')
        .eq('employee_id', employeeUuid)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (res.error || !res.data || !res.data.token) {
        alert('Could not find an invite link to copy. Try Send Invite again.');
        return;
      }
      var url = 'https://captainclean115-oss.github.io/cleaningapp/accept-invite.html?token=' + res.data.token;
      await navigator.clipboard.writeText(url);
      _renderInviteResult(rosterId, '<span style=\"color:var(--green)\">Link copied to clipboard.</span>');
    } catch (e) {
      alert('Could not copy the link: ' + ((e && e.message) || 'unknown error'));
    }
  }

  async function pentaSendInvite(rosterId) {
    if (_inviteInFlight[rosterId]) return; // double-click guard
    var lastSent = _inviteLastSentAt[rosterId];
    if (lastSent && (Date.now() - lastSent) < 60000) {
      var waitSec = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
      _renderInviteResult(rosterId, '<span style=\"color:var(--amber)\">Please wait ' + waitSec + 's before resending.</span>');
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
      _renderInviteResult(rosterId, '<span style=\"color:var(--red)\">No phone number on file for ' + (emp.first_name || 'this employee') + '. Add one in the Staff edit form first.</span>');
      return;
    }
    // Phone + password login feature: block the invite if this phone is
    // shared with another ACTIVE employee -- phone login/reset need it
    // to uniquely resolve an account for invites going forward.
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
          _renderInviteResult(rosterId, '<span style=\"color:var(--red)\">' + (emp.first_name || 'This employee') + '\\'s phone number is shared with ' + (_dupOwner.first_name || 'another active employee') + '. Fix one of their phone numbers first.</span>');
          return;
        }
      }
    } catch (e) { console.warn('[pentaSendInvite] duplicate-phone check failed (non-fatal, proceeding)', e); }

    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) {
      alert('Supabase client not ready. Reload the page.');
      return;
    }

    _inviteInFlight[rosterId] = true;
    _renderInviteResult(rosterId, '<span style=\"color:var(--muted)\">Sending…</span>');
    try {
      var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id } });
      _inviteLastSentAt[rosterId] = Date.now();
      if (res.error || !res.data || !res.data.success) {
        var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'Could not send the invite.';
        _renderInviteResult(rosterId,
          '<span style=\"color:var(--red)\">' + _adminEsc(reason) + '</span>'
          + '<button type=\"button\" onclick=\"copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, \"\\\\'\") + '\\')\" style=\"display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer\">Copy invite link</button>');
        return;
      }
      var sentTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      _renderInviteResult(rosterId, '<span style=\"color:var(--green)\">Sent to ' + _maskPhone(emp.phone) + ' at ' + sentTime + '.</span>');
      try { if (typeof pentaRenderInviteChip === 'function') { /* chip re-render happens on its own poll/next open */ } } catch (e) {}
    } catch (e) {
      _renderInviteResult(rosterId,
        '<span style=\"color:var(--red)\">Network error -- could not reach the server.</span>'
        + '<button type=\"button\" onclick=\"copyInviteLink(\\'' + emp.id + '\\',\\'' + rosterId.replace(/'/g, \"\\\\'\") + '\\')\" style=\"display:block;margin-top:6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer\">Copy invite link</button>');
      console.error('[pentaSendInvite] send-invite call threw', e);
    } finally {
      _inviteInFlight[rosterId] = false;
    }
  }
"""

EDITS = [("Server-side send-invite: rewrite pentaSendInvite, remove pentaShowInviteSendModal", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
