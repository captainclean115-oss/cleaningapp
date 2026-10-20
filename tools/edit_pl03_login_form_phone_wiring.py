#!/usr/bin/env python3
"""Phone + password login feature. pentaWireLoginForm() gains phone-mode
handling: a mode toggle, phone-mode submit (signInWithPhone), and
phone-mode forgot-password (requestPhoneReset). The EXISTING email-mode
submit/forgot-password branches (managers, and any employee who prefers
email) are preserved byte-for-byte -- this only ADDS an else-branch.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// Wire manager login form handlers. Called once on boot when no session exists.
function pentaWireLoginForm() {
  var form = document.getElementById('penta-login-form');
  if (!form) return;
  var errEl = document.getElementById('penta-login-error');
  var pwEl  = document.getElementById('penta-login-password');
  var emEl  = document.getElementById('penta-login-email');
  var btn   = document.getElementById('penta-login-submit');

  function showErr(msg) {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
    errEl.style.color = '#fca5a5';
    errEl.style.background = 'rgba(220,38,38,0.12)';
    errEl.style.borderColor = 'rgba(220,38,38,0.35)';
  }
  function showOk(msg) {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
    errEl.style.color = '#34d399';
    errEl.style.background = 'rgba(52,211,153,0.12)';
    errEl.style.borderColor = 'rgba(52,211,153,0.35)';
  }

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    showErr('');
    var email = (emEl.value || '').trim();
    var password = pwEl.value || '';
    if (!email || !password) { showErr('Enter email and password.'); return; }
    if (!window.PentaAuth || !window.PentaAuth.signIn) {
      showErr('Auth not ready — refresh and try again.'); return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    var r = await window.PentaAuth.signIn(email, password);
    if (r && r.error) {
      showErr(r.error);
      if (pwEl) pwEl.value = '';
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      return;
    }
    // Supabase client has persisted the session. Reload so the full app
    // boots with an authenticated session (Phase 3C/3D activate cleanly).
    window.location.reload();
  });

  var forgot = document.getElementById('penta-login-forgot-link');
  if (forgot) forgot.addEventListener('click', async function(e){
    e.preventDefault();
    var email = (emEl.value || '').trim();
    if (!email) { showErr('Enter your email first.'); return; }
    if (!window.PentaAuth || !window.PentaAuth.resetPassword) {
      showErr('Auth not ready — refresh and try again.'); return;
    }
    var r = await window.PentaAuth.resetPassword(email);
    if (r && r.error) { showErr(r.error); return; }
    showOk('Password reset email sent. Check your inbox.');
  });
}"""

NEW = """// Wire manager login form handlers. Called once on boot when no session exists.
// Phone + password login feature: gained phone-mode handling alongside
// the original email mode. Email mode (default on load) is byte-for-byte
// the same signIn()/resetPassword() calls as before this feature.
function pentaWireLoginForm() {
  var form = document.getElementById('penta-login-form');
  if (!form) return;
  var errEl = document.getElementById('penta-login-error');
  var pwEl  = document.getElementById('penta-login-password');
  var emEl  = document.getElementById('penta-login-email');
  var phEl  = document.getElementById('penta-login-phone');
  var btn   = document.getElementById('penta-login-submit');
  var emailField = document.getElementById('penta-login-email-field');
  var phoneField = document.getElementById('penta-login-phone-field');
  var modeToggle = document.getElementById('penta-login-mode-toggle');
  var _loginMode = 'email'; // 'email' | 'phone'

  function showErr(msg) {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
    errEl.style.color = '#fca5a5';
    errEl.style.background = 'rgba(220,38,38,0.12)';
    errEl.style.borderColor = 'rgba(220,38,38,0.35)';
  }
  function showOk(msg) {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
    errEl.style.color = '#34d399';
    errEl.style.background = 'rgba(52,211,153,0.12)';
    errEl.style.borderColor = 'rgba(52,211,153,0.35)';
  }

  if (modeToggle) modeToggle.addEventListener('click', function(e){
    e.preventDefault();
    showErr('');
    _loginMode = (_loginMode === 'email') ? 'phone' : 'email';
    if (emailField) emailField.style.display = (_loginMode === 'email') ? '' : 'none';
    if (phoneField) phoneField.style.display = (_loginMode === 'phone') ? '' : 'none';
    if (emEl) emEl.required = (_loginMode === 'email');
    modeToggle.textContent = (_loginMode === 'email') ? 'Sign in with phone number instead' : 'Sign in with email instead';
  });

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    showErr('');
    var password = pwEl.value || '';

    if (_loginMode === 'phone') {
      var phone = (phEl && phEl.value || '').trim();
      if (!phone || !password) { showErr('Enter your phone number and password.'); return; }
      if (!window.PentaAuth || !window.PentaAuth.signInWithPhone) {
        showErr('Auth not ready — refresh and try again.'); return;
      }
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
      var rp = await window.PentaAuth.signInWithPhone(phone, password);
      if (rp && rp.error) {
        showErr(rp.error);
        if (pwEl) pwEl.value = '';
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
        return;
      }
      window.location.reload();
      return;
    }

    var email = (emEl.value || '').trim();
    if (!email || !password) { showErr('Enter email and password.'); return; }
    if (!window.PentaAuth || !window.PentaAuth.signIn) {
      showErr('Auth not ready — refresh and try again.'); return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    var r = await window.PentaAuth.signIn(email, password);
    if (r && r.error) {
      showErr(r.error);
      if (pwEl) pwEl.value = '';
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      return;
    }
    // Supabase client has persisted the session. Reload so the full app
    // boots with an authenticated session (Phase 3C/3D activate cleanly).
    window.location.reload();
  });

  var forgot = document.getElementById('penta-login-forgot-link');
  if (forgot) forgot.addEventListener('click', async function(e){
    e.preventDefault();
    if (_loginMode === 'phone') {
      var phone2 = (phEl && phEl.value || '').trim();
      if (!phone2) { showErr('Enter your phone number first.'); return; }
      if (!window.PentaAuth || !window.PentaAuth.requestPhoneReset) {
        showErr('Auth not ready — refresh and try again.'); return;
      }
      var rr = await window.PentaAuth.requestPhoneReset(phone2);
      showOk((rr && rr.message) || 'If that number is on file, a text is on its way.');
      return;
    }
    var email = (emEl.value || '').trim();
    if (!email) { showErr('Enter your email first.'); return; }
    if (!window.PentaAuth || !window.PentaAuth.resetPassword) {
      showErr('Auth not ready — refresh and try again.'); return;
    }
    var r = await window.PentaAuth.resetPassword(email);
    if (r && r.error) { showErr(r.error); return; }
    showOk('Password reset email sent. Check your inbox.');
  });
}"""

EDITS = [("pentaWireLoginForm: phone-mode toggle, sign-in, and forgot-password", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
