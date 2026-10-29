#!/usr/bin/env python3
"""Claire portal-links feature, step 3:
1. Extract pentaSendInvite's duplicate-active-phone check into a shared
   helper (_findDuplicateActivePhoneOwner) so the new
   pentaSendPasswordReset doesn't re-derive the same logic a second way.
2. Add pentaSendPasswordReset(rosterId) -- a NEW function (there is no
   existing reset code path to reuse; invite's own guard SHAPE is
   mirrored deliberately: double-click guard set synchronously before
   any await, one try/finally, a 60s resend cooldown, same resolver,
   same structured return value) that calls send-invite with
   action:'reset'. Reused by Claire's send_password_reset_link tool.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

DUP_CHECK_OLD = """      // Phone + password login feature: block the invite if this phone
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
      } catch (e) { console.warn('[pentaSendInvite] duplicate-phone check failed (non-fatal, proceeding)', e); }"""

DUP_CHECK_NEW = """      // Phone + password login feature: block the invite if this phone
      // is shared with another ACTIVE employee -- phone login/reset
      // need it to uniquely resolve an account for invites going
      // forward.
      var _dupReason = _findDuplicateActivePhoneOwnerReason(emp);
      if (_dupReason) {
        _renderInviteResult(rosterId, '<span style="color:var(--red)">' + _dupReason + '</span>');
        return { ok: false, employeeId: emp.id, reason: _dupReason };
      }"""

HELPER_INSERT_OLD = """  function _maskPhone(phone) {
    var digits = String(phone || '').replace(/\\D/g, '');
    var last4 = digits.slice(-4);
    return last4.length === 4 ? ('***-***-' + last4) : 'her phone';
  }"""

HELPER_INSERT_NEW = """  function _maskPhone(phone) {
    var digits = String(phone || '').replace(/\\D/g, '');
    var last4 = digits.slice(-4);
    return last4.length === 4 ? ('***-***-' + last4) : 'her phone';
  }

  // Shared by pentaSendInvite and pentaSendPasswordReset (Claire portal-
  // links feature) -- extracted so both callers check the exact same
  // way instead of two copies that could drift. Returns a plain-English
  // reason string if emp's phone is shared with another ACTIVE
  // employee, or null if it's fine to proceed. Never throws -- a lookup
  // failure is non-fatal and treated as "no duplicate found."
  function _findDuplicateActivePhoneOwnerReason(emp) {
    try {
      var _normInv = String(emp.phone || '').replace(/\\D/g, '');
      if (_normInv.length === 11 && _normInv[0] === '1') _normInv = _normInv.slice(1);
      if (_normInv.length !== 10 || !window.PentaEmployees || !window.PentaEmployees.listSync) return null;
      var _dupOwner = window.PentaEmployees.listSync().find(function (e) {
        if (!e || e.id === emp.id || e.status !== 'active') return false;
        var n2 = String(e.phone || '').replace(/\\D/g, '');
        if (n2.length === 11 && n2[0] === '1') n2 = n2.slice(1);
        return n2.length === 10 && n2 === _normInv;
      });
      if (!_dupOwner) return null;
      return (emp.first_name || 'This employee') + '\\'s phone number is shared with ' + (_dupOwner.first_name || 'another active employee') + '. Fix one of their phone numbers first.';
    } catch (e) {
      console.warn('[_findDuplicateActivePhoneOwnerReason] check failed (non-fatal, treated as no duplicate)', e);
      return null;
    }
  }

  // Claire portal-links feature -- a password-reset text for an
  // employee who ALREADY has a login. Mirrors pentaSendInvite's own
  // guard shape exactly (sync double-click flag, one try/finally, 60s
  // resend cooldown, same resolver, same structured return) but with
  // its own separate in-flight/last-sent maps -- sending an invite and
  // sending a reset are independent actions and shouldn't cool each
  // other down. No Staff-screen button calls this yet (this PR only
  // adds Claire's tool); it exists here, once, for both to share later
  // instead of Claire growing a private copy.
  var _resetInFlight = {};
  var _resetLastSentAt = {};
  async function pentaSendPasswordReset(rosterId) {
    if (_resetInFlight[rosterId]) return { ok: false, reason: 'already_sending' };
    _resetInFlight[rosterId] = true;
    try {
      var lastSent = _resetLastSentAt[rosterId];
      if (lastSent && (Date.now() - lastSent) < 60000) {
        var waitSec = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
        return { ok: false, reason: 'Please wait ' + waitSec + 's before resending.' };
      }

      var resolved;
      try {
        resolved = await _resolveEmployeeByRoster(rosterId);
      } catch (e) {
        console.error('[pentaSendPasswordReset] resolver crash', e);
        return { ok: false, reason: 'Resolver crashed: ' + ((e && e.message) || String(e)) };
      }
      if (resolved.error) {
        console.error('[pentaSendPasswordReset]', resolved.error);
        return { ok: false, reason: (resolved.error.msg || 'Could not look up this employee.') };
      }

      var emp = resolved.employee;
      if (!emp.phone) {
        return { ok: false, employeeId: emp.id, reason: 'No phone number on file.' };
      }
      if (!emp.auth_user_id) {
        return { ok: false, employeeId: emp.id, reason: 'This employee doesn\\'t have a login yet. Send an invite instead.' };
      }
      var _dupReason2 = _findDuplicateActivePhoneOwnerReason(emp);
      if (_dupReason2) {
        return { ok: false, employeeId: emp.id, reason: _dupReason2 };
      }

      var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
      if (!sb) {
        return { ok: false, employeeId: emp.id, reason: 'Supabase client not ready. Reload the page.' };
      }

      try {
        var res = await sb.functions.invoke('send-invite', { body: { employee_id: emp.id, action: 'reset' } });
        _resetLastSentAt[rosterId] = Date.now();
        if (res.error || !res.data || !res.data.success) {
          var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'Could not send the reset text.';
          return { ok: false, employeeId: emp.id, reason: reason };
        }
        var sentTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return { ok: true, employeeId: emp.id, maskedPhone: _maskPhone(emp.phone), sentTime: sentTime };
      } catch (e) {
        console.error('[pentaSendPasswordReset] send-invite call threw', e);
        return { ok: false, employeeId: emp.id, reason: 'Network error -- could not reach the server.' };
      }
    } finally {
      _resetInFlight[rosterId] = false;
    }
  }"""

apply_edits([
    ("pentaSendInvite: use the shared duplicate-active-phone helper instead of its own inline copy", DUP_CHECK_OLD, DUP_CHECK_NEW),
    ("add _findDuplicateActivePhoneOwnerReason + pentaSendPasswordReset", HELPER_INSERT_OLD, HELPER_INSERT_NEW),
])
