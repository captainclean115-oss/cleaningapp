#!/usr/bin/env python3
"""login-hang-fix -- PART 3. Two small, separate additions:

1. A global `unhandledrejection` listener, registered as the very first
   statement in the app's script block (before anything else can throw).
   This is the safety net the diagnosis flagged as missing entirely --
   today, ANY unhandled promise rejection anywhere in the app just
   vanishes into the browser console with no trace a human would ever
   see, including a login-button-stuck case like tonight's if the
   exception path reached this far (it didn't quite, in this specific
   bug -- see PART 2 -- but the NEXT one might). It logs clearly and
   records the same lightweight {message, time} shape the existing
   facade `_lastError` getters already use throughout this file, so
   it's inspectable the same way (`window._pentaLastUnhandledError`)
   without inventing a new UI panel.

2. onAuthStateChange('SIGNED_OUT') in the PentaAuth IIFE now also clears
   the locally-stored session token. gotrue-js already signs the user out
   locally when a background token refresh fails (which is what produced
   tonight's "Invalid Refresh Token" / "Session not found" auth-log
   entries) -- but our OWN boot router makes its own, separate, SYNCHRONOUS
   decision from the raw localStorage blob before gotrue's async cleanup
   necessarily finishes, so a dead token can still get optimistically
   trusted on the very next page load. Clearing it here too closes that
   gap without touching the normal sign-out path (removing an
   already-removed key is a harmless no-op).
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_TOP = """<script>
// ─────────────────────────────────────────────────────────────────────────
// PentaTenant — resolved business_id for the current session."""

NEW_TOP = """<script>
// login-hang-fix: global safety net, registered first so it's in place
// before anything else in this script can throw. An unhandled rejection
// anywhere in the app used to just vanish -- now it's always logged
// clearly and recorded somewhere inspectable, the same {message, time}
// shape the existing per-module `_lastError` getters already use.
window.addEventListener('unhandledrejection', function (event) {
  var reason = event && event.reason;
  var message = (reason && reason.message) || String(reason || 'unknown error');
  console.error('[unhandled rejection]', message, reason);
  window._pentaLastUnhandledError = { message: message, time: new Date().toISOString() };
});

// ─────────────────────────────────────────────────────────────────────────
// PentaTenant — resolved business_id for the current session."""

OLD_CLIENT = """  waitForSDK(function(){
    var client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    window.PentaAuth = {"""

NEW_CLIENT = """  waitForSDK(function(){
    var client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    // login-hang-fix: gotrue-js already signs the user out locally when a
    // background token refresh fails -- but it does that asynchronously,
    // and our boot router makes its own synchronous decision from the raw
    // localStorage blob before that cleanup necessarily lands. Clearing it
    // here too means the NEXT page load never optimistically trusts a
    // token gotrue has already given up on.
    try {
      client.auth.onAuthStateChange(function (event) {
        if (event === 'SIGNED_OUT') { try { localStorage.removeItem('sb-wymoezilyjmyibmuqqmr-auth-token'); } catch (e) {} }
      });
    } catch (e) {}

    window.PentaAuth = {"""

EDITS = [
    ("login-hang-fix: register the global unhandledrejection safety net first in the script", OLD_TOP, NEW_TOP),
    ("login-hang-fix: clear the stored session token on an unexpected SIGNED_OUT", OLD_CLIENT, NEW_CLIENT),
]

if __name__ == "__main__":
    apply_edits(EDITS)
