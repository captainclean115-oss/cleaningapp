#!/usr/bin/env python3
"""Fix login button, step 2: wire the click handler (same block that
already wires Send Invite / Set Temp Password), and add the new
pentaFixLogin / _pentaConfirmFixLogin / _pentaCancelFixLogin functions
inside the existing "Penta invite helpers" IIFE, reusing its existing
_resolveEmployeeByRoster, _extractInviteError (shared with send-invite,
PR #205), and SB() helpers rather than forking them.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD_WIRE = """  // Wire up the Penta Login section (Sprint 4 Phase 4B).
  try {
    var _rid = emp.legacy_roster_id || emp.id || emp.name;
    var _chip   = document.querySelector('[data-invite-chip][data-roster-id="' + CSS.escape(_rid) + '"]');
    var _sendBt = document.querySelector('[data-action="send-invite"][data-roster-id="' + CSS.escape(_rid) + '"]');
    var _pwBt   = document.querySelector('[data-action="set-temp-pw"][data-roster-id="' + CSS.escape(_rid) + '"]');
    if (_sendBt) _sendBt.addEventListener('click', function() { pentaSendInvite(_rid); });
    if (_pwBt)   _pwBt.addEventListener('click',   function() { pentaShowSetTempPasswordModal(_rid); });
    if (_chip && typeof pentaRenderInviteChip === 'function') pentaRenderInviteChip(_rid, _chip, _sendBt);
    if (typeof applyPermissions === 'function') applyPermissions();
  } catch (e) { console.warn('[Penta Login section] wiring failed', e); }"""

NEW_WIRE = """  // Wire up the Penta Login section (Sprint 4 Phase 4B).
  try {
    var _rid = emp.legacy_roster_id || emp.id || emp.name;
    var _chip   = document.querySelector('[data-invite-chip][data-roster-id="' + CSS.escape(_rid) + '"]');
    var _sendBt = document.querySelector('[data-action="send-invite"][data-roster-id="' + CSS.escape(_rid) + '"]');
    var _pwBt   = document.querySelector('[data-action="set-temp-pw"][data-roster-id="' + CSS.escape(_rid) + '"]');
    var _fixBt  = document.querySelector('[data-action="fix-login"][data-roster-id="' + CSS.escape(_rid) + '"]');
    if (_sendBt) _sendBt.addEventListener('click', function() { pentaSendInvite(_rid); });
    if (_pwBt)   _pwBt.addEventListener('click',   function() { pentaShowSetTempPasswordModal(_rid); });
    if (_fixBt)  _fixBt.addEventListener('click',  function() { pentaFixLogin(_rid); });
    if (_chip && typeof pentaRenderInviteChip === 'function') pentaRenderInviteChip(_rid, _chip, _sendBt);
    if (typeof applyPermissions === 'function') applyPermissions();
  } catch (e) { console.warn('[Penta Login section] wiring failed', e); }"""

OLD_EXPORTS = """  window.pentaGenerateInviteToken      = pentaGenerateInviteToken;
  window.pentaInviteStatus             = pentaInviteStatus;
  window.pentaRenderInvitePill         = pentaRenderInvitePill;
  window.pentaRenderInvitePillsBatch   = pentaRenderInvitePillsBatch;
  window.pentaRenderInviteChip         = pentaRenderInviteChip;
  window.pentaSendInvite               = pentaSendInvite;
  window.pentaShowSetTempPasswordModal = pentaShowSetTempPasswordModal;
  window.pentaSetTempPassword          = pentaSetTempPassword;
})();"""

NEW_EXPORTS = """  // Fix login (owner/admin only -- repair-login-email's own server-
  // side role check is the real boundary; renderStaffView's
  // _showFixLogin gate is what keeps the button itself hidden from
  // everyone else). One employee at a time, never bulk. Dry run first,
  // always -- the server defaults dry_run to true on its own, but this
  // button is explicit about it so a future change to that default can
  // never silently skip the preview step here.
  var _fixLoginInFlight = {};

  function _renderFixLoginPanel(rosterId, html) {
    var el = document.querySelector('[id="fix-login-panel"][data-roster-id="' + CSS.escape(rosterId) + '"]');
    if (!el) return;
    el.innerHTML = html;
    el.style.display = html ? 'block' : 'none';
  }

  function _pentaCancelFixLogin(rosterId) {
    _renderFixLoginPanel(rosterId, '');
  }

  async function pentaFixLogin(rosterId) {
    if (_fixLoginInFlight[rosterId]) return;
    _fixLoginInFlight[rosterId] = true;
    _renderFixLoginPanel(rosterId, '<span style="color:var(--muted)">Checking…</span>');
    try {
      var resolved = await _resolveEmployeeByRoster(rosterId);
      if (resolved.error || !resolved.employee) {
        _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">Could not load this employee. Reload and try again.</span>');
        return;
      }
      var emp = resolved.employee;
      var sb = SB();
      if (!sb) {
        _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">Not connected — reload and try again.</span>');
        return;
      }
      var res = await sb.functions.invoke('repair-login-email', { body: { employee_id: emp.id, dry_run: true } });
      if (res.error || !res.data) {
        var extracted = await _extractInviteError(res);
        _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">' + _adminEsc(extracted.message) + '</span>');
        return;
      }
      var data = res.data;
      if (data.status === 'already_correct') {
        _renderFixLoginPanel(rosterId, '<span style="color:var(--green)">Login already matches this phone number. Nothing to fix.</span>');
        return;
      }
      if (data.status === 'would_change') {
        var _last4 = String(data.phone_masked || '').slice(-4);
        _renderFixLoginPanel(rosterId,
          '<div style="margin-bottom:8px">This will move the login from the old number to the number ending ' + _adminEsc(_last4) + '. Password and history stay. Staff email will be updated to match.</div>'
          + '<div style="display:flex;gap:8px">'
          + '<button type="button" id="fix-login-confirm-btn" data-roster-id="' + _adminEsc(rosterId) + '" style="flex:1;padding:8px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">Confirm fix</button>'
          + '<button type="button" id="fix-login-cancel-btn" data-roster-id="' + _adminEsc(rosterId) + '" style="flex:1;padding:8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">Cancel</button>'
          + '</div>');
        var _confirmBt = document.querySelector('[id="fix-login-confirm-btn"][data-roster-id="' + CSS.escape(rosterId) + '"]');
        var _cancelBt  = document.querySelector('[id="fix-login-cancel-btn"][data-roster-id="' + CSS.escape(rosterId) + '"]');
        if (_confirmBt) _confirmBt.addEventListener('click', function() { _pentaConfirmFixLogin(rosterId, emp.id); });
        if (_cancelBt)  _cancelBt.addEventListener('click',  function() { _pentaCancelFixLogin(rosterId); });
        return;
      }
      // Collision refusal or any other server status/error -- shown
      // verbatim, never replaced with a generic message.
      _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">' + _adminEsc((data && data.error) || 'Unexpected response from the server.') + '</span>');
    } catch (e) {
      _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">Network error — could not reach the server.</span>');
      console.error('[pentaFixLogin] threw', e);
    } finally {
      _fixLoginInFlight[rosterId] = false;
    }
  }

  async function _pentaConfirmFixLogin(rosterId, employeeId) {
    var btn = document.querySelector('[id="fix-login-confirm-btn"][data-roster-id="' + CSS.escape(rosterId) + '"]');
    // Double-tap guard: a disabled button never fires a second call.
    if (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Fixing…';
    }
    try {
      var sb = SB();
      if (!sb) {
        _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">Not connected — reload and try again.</span>');
        return;
      }
      var res = await sb.functions.invoke('repair-login-email', { body: { employee_id: employeeId, dry_run: false } });
      if (res.error || !res.data) {
        var extracted = await _extractInviteError(res);
        _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">' + _adminEsc(extracted.message) + '</span>');
        var retryBt = document.querySelector('[id="fix-login-confirm-btn"][data-roster-id="' + CSS.escape(rosterId) + '"]');
        if (retryBt) { retryBt.disabled = false; retryBt.textContent = 'Confirm fix'; }
        return;
      }
      var data = res.data;
      if (data.status === 'repaired') {
        _renderFixLoginPanel(rosterId, '<span style="color:var(--green)">Login fixed. Staff email now ends ' + _adminEsc(data.new_email_suffix || '') + '.</span>');
        // Refresh the underlying data in the background so the next time
        // this profile is opened it shows the corrected email -- the
        // success message above (suffix only, by design) is the visible
        // confirmation for right now; a full re-render here would wipe
        // this exact message off the screen.
        try { if (window.PentaEmployees && window.PentaEmployees._hydrate) await window.PentaEmployees._hydrate(); } catch (e2) {}
      } else {
        _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">' + _adminEsc((data && data.error) || 'Could not finish the repair.') + '</span>');
        var retryBt2 = document.querySelector('[id="fix-login-confirm-btn"][data-roster-id="' + CSS.escape(rosterId) + '"]');
        if (retryBt2) { retryBt2.disabled = false; retryBt2.textContent = 'Confirm fix'; }
      }
    } catch (e) {
      _renderFixLoginPanel(rosterId, '<span style="color:var(--red)">Network error — could not reach the server.</span>');
      console.error('[_pentaConfirmFixLogin] threw', e);
      var retryBt3 = document.querySelector('[id="fix-login-confirm-btn"][data-roster-id="' + CSS.escape(rosterId) + '"]');
      if (retryBt3) { retryBt3.disabled = false; retryBt3.textContent = 'Confirm fix'; }
    }
  }

  window.pentaGenerateInviteToken      = pentaGenerateInviteToken;
  window.pentaInviteStatus             = pentaInviteStatus;
  window.pentaRenderInvitePill         = pentaRenderInvitePill;
  window.pentaRenderInvitePillsBatch   = pentaRenderInvitePillsBatch;
  window.pentaRenderInviteChip         = pentaRenderInviteChip;
  window.pentaSendInvite               = pentaSendInvite;
  window.pentaShowSetTempPasswordModal = pentaShowSetTempPasswordModal;
  window.pentaSetTempPassword          = pentaSetTempPassword;
  window.pentaFixLogin                 = pentaFixLogin;
})();"""

apply_edits([
    ("Wire the Fix login button click handler", OLD_WIRE, NEW_WIRE),
    ("Add pentaFixLogin/_pentaConfirmFixLogin/_pentaCancelFixLogin + export pentaFixLogin", OLD_EXPORTS, NEW_EXPORTS),
])
