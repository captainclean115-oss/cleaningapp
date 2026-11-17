#!/usr/bin/env python3
"""login-hang-fix -- PART 2. The core fix.

pentaWireLoginForm's submit handler had NO error handling at all around
PentaAuth.signIn / signInWithPhone: no try/catch, no timeout, no finally.
If that call ever threw (instead of cleanly returning {error}) or simply
never resolved, the button stayed disabled on "Signing in..." forever --
confirmed reproducible with a sandboxed stub, no real credentials needed.

Fix: wrap both the email and phone paths in try/catch/finally, race every
sign-in call against an 18s timeout (_pentaWithTimeout), and show one of
several distinct messages depending on what actually went wrong (wrong
credentials / rate-limited / network or timeout / stale local session /
anything else = generic server error). The finally block ALWAYS re-enables
the button and resets its text, even when the try block returns early.

Also adds _pentaClearStaleSession(): on an "Invalid Refresh Token" /
"Session not found" error specifically (the two errors seen in tonight's
Supabase auth logs), clears the locally-stored Supabase session token so
the NEXT sign-in attempt starts clean instead of the boot router keep
optimistically trusting a dead local blob.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_HELPERS_ANCHOR = """// Wire manager login form handlers. Called once on boot when no session exists.
// Phone + password login feature: gained phone-mode handling alongside
// the original email mode. Email mode (default on load) is byte-for-byte
// the same signIn()/resetPassword() calls as before this feature.
function pentaWireLoginForm() {"""

NEW_HELPERS_ANCHOR = """// login-hang-fix: races any promise against a fixed timeout so a hung
// network call (stalled connection, unresponsive edge region, etc.) can
// never block the UI forever. Does not abort the underlying call --
// Supabase's SDK gives us no handle to cancel it -- it just stops the
// caller from waiting on it past `ms`.
function _pentaWithTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; reject(new Error('penta-login-timeout')); }, ms);
    promise.then(
      function (v) { clearTimeout(timer); if (!timedOut) resolve(v); },
      function (e) { clearTimeout(timer); if (!timedOut) reject(e); }
    );
  });
}

// login-hang-fix: tonight's Supabase auth logs showed "Invalid Refresh
// Token" / "Session not found" errors -- these mean the token this
// browser has stored locally is dead. The boot router's sync JWT decode
// only checks the stored blob's SHAPE (access_token + user present), not
// whether it's actually still valid, so a dead token gets optimistically
// trusted on the next page load unless something clears it. Clearing it
// here means the very next sign-in attempt (or page load) starts clean
// instead of looping on the same stale token.
function _pentaClearStaleSession() {
  try { localStorage.removeItem('sb-wymoezilyjmyibmuqqmr-auth-token'); } catch (e) {}
}

// login-hang-fix: one message per failure class, so "couldn't sign in"
// always says WHY. `raw` is either a thrown Error (network/timeout/SDK
// exception) or the plain error string PentaAuth's signIn/signInWithPhone
// already return on a clean {error} result.
function _pentaLoginErrorMessage(raw) {
  var msg = (raw && raw.message) || String(raw || '');
  if (msg === 'penta-login-timeout') {
    return "Couldn't sign in: taking too long to respond. Tap Sign in to try again.";
  }
  if (/invalid login credentials/i.test(msg)) {
    return "Couldn't sign in: wrong email/phone or password. Tap Sign in to try again.";
  }
  if (/rate limit|too many requests|429/i.test(msg)) {
    return "Couldn't sign in: too many attempts -- please wait a bit and try again.";
  }
  if (/invalid refresh token|session not found/i.test(msg)) {
    _pentaClearStaleSession();
    return "Couldn't sign in: your saved sign-in had expired and has been cleared. Tap Sign in to try again.";
  }
  if (/network|fetch|failed to fetch/i.test(msg)) {
    return "Couldn't sign in: network error. Check your connection and tap Sign in to try again.";
  }
  return "Couldn't sign in: " + (msg || 'server error') + ". Tap Sign in to try again.";
}

// Wire manager login form handlers. Called once on boot when no session exists.
// Phone + password login feature: gained phone-mode handling alongside
// the original email mode. Email mode (default on load) is byte-for-byte
// the same signIn()/resetPassword() calls as before this feature.
function pentaWireLoginForm() {"""

OLD_SUBMIT = """  form.addEventListener('submit', async function(e){
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
  });"""

NEW_SUBMIT = """  form.addEventListener('submit', async function(e){
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
      try {
        var rp = await _pentaWithTimeout(window.PentaAuth.signInWithPhone(phone, password), 18000);
        if (rp && rp.error) {
          showErr(_pentaLoginErrorMessage(rp.error));
          if (pwEl) pwEl.value = '';
          return;
        }
        window.location.reload();
      } catch (err) {
        console.error('[login] phone sign-in failed', err);
        showErr(_pentaLoginErrorMessage(err));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      }
      return;
    }

    var email = (emEl.value || '').trim();
    if (!email || !password) { showErr('Enter email and password.'); return; }
    if (!window.PentaAuth || !window.PentaAuth.signIn) {
      showErr('Auth not ready — refresh and try again.'); return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    try {
      var r = await _pentaWithTimeout(window.PentaAuth.signIn(email, password), 18000);
      if (r && r.error) {
        showErr(_pentaLoginErrorMessage(r.error));
        if (pwEl) pwEl.value = '';
        return;
      }
      // Supabase client has persisted the session. Reload so the full app
      // boots with an authenticated session (Phase 3C/3D activate cleanly).
      window.location.reload();
    } catch (err) {
      console.error('[login] email sign-in failed', err);
      showErr(_pentaLoginErrorMessage(err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    }
  });"""

EDITS = [
    ("login-hang-fix: add timeout/error-message/stale-session helpers before pentaWireLoginForm", OLD_HELPERS_ANCHOR, NEW_HELPERS_ANCHOR),
    ("login-hang-fix: wrap email + phone sign-in calls in try/catch/finally with a timeout", OLD_SUBMIT, NEW_SUBMIT),
]

if __name__ == "__main__":
    apply_edits(EDITS)
