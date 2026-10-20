#!/usr/bin/env python3
"""Phone + password login feature. Adds PentaAuth.signInWithPhone (calls
the new phone-login Edge Function, then establishes the real client
session via setSession) and PentaAuth.requestPhoneReset (calls the new
request-password-reset Edge Function). PentaAuth.signIn/resetPassword
(the existing email-based manager flow) are completely untouched --
these are additional methods on the same object, not a replacement.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """      resetPassword: async function(email){
        var r = await client.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + window.location.pathname
        });
        if (r.error) return { error: r.error.message };
        return { ok: true };
      },

      signOut: async function(){"""

NEW = """      resetPassword: async function(email){
        var r = await client.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + window.location.pathname
        });
        if (r.error) return { error: r.error.message };
        return { ok: true };
      },

      // Phone + password login feature. Raw fetch, not functions.invoke --
      // invoke swallows non-2xx response bodies (bit this app before on
      // claire-chat/geotab, see PentaClientHealth.runScoring's own
      // comment) and the whole point of phone-login's 401/429 bodies is
      // the generic-but-present error message this needs to show.
      signInWithPhone: async function(phone, password){
        try {
          var resp = await fetch(PROJECT_URL + '/functions/v1/phone-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': PUBLISHABLE_KEY },
            body: JSON.stringify({ phone: phone, password: password })
          });
          var body = null;
          try { body = await resp.json(); } catch (e) {}
          if (!resp.ok) return { error: (body && body.error) || ('Sign-in failed (HTTP ' + resp.status + ')') };
          if (!body || !body.access_token || !body.refresh_token) return { error: 'Sign-in failed -- no session returned.' };
          var setRes = await client.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
          if (setRes.error) return { error: setRes.error.message };
          this.session = setRes.data.session;
          return { ok: true };
        } catch (e) {
          return { error: 'Network error -- check your connection and try again.' };
        }
      },

      // Phone + password login feature. Always resolves to { ok: true }
      // with the SAME generic message on any outcome except a genuine
      // RingCentral-unreachable error (502, see that Edge Function's own
      // comment for why that one case is allowed to differ) -- never
      // throws, never reveals whether the phone was found.
      requestPhoneReset: async function(phone){
        try {
          var resp = await fetch(PROJECT_URL + '/functions/v1/request-password-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': PUBLISHABLE_KEY },
            body: JSON.stringify({ phone: phone })
          });
          var body = null;
          try { body = await resp.json(); } catch (e) {}
          if (resp.status === 502 && body && body.error === 'sms_unavailable') {
            return { ok: true, message: body.message };
          }
          return { ok: true, message: (body && body.message) || 'If that number is on file, a text is on its way.' };
        } catch (e) {
          return { ok: true, message: 'Could not reach the server. Please call the office.' };
        }
      },

      signOut: async function(){"""

EDITS = [("PentaAuth: add signInWithPhone + requestPhoneReset methods", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
