#!/usr/bin/env python3
"""Claire auth-refresh fix -- STEP 2.

DIAGNOSIS: _claireApi grabs the access token via a single
sb.auth.getSession() call, then does a RAW fetch with it -- bypassing
whatever retry/refresh logic supabase-js's own request wrapper might
otherwise apply for .from()/.functions.invoke() calls. If getSession()
comes back with no usable session (the app's own background auto-
refresh timer is a setTimeout, and iOS aggressively throttles/suspends
JS timers for a backgrounded Safari tab or PWA -- confirmed via the
project's own Auth logs: closely-spaced /user and refresh-token-grant
calls from the same device/session, plus 20 real 401/insufficient_
privilege rejections on a DIFFERENT REST call -- /rest/v1/users role
lookups, the same auth-derivation path Claire's own session check
uses -- out of 3024 in the last 24h), _claireApi had ZERO retry logic:
it threw "no active session (sign in again)" immediately. Confirmed via
the claire-chat Edge Function's own logs: ZERO requests reached
/functions/v1/claire-chat in the entire last 24h -- the failure never
even reaches the network/EF stage, it's 100% client-side.

Fix: getSession() first (unchanged, cheap, no network). If that comes
back empty, OR if the first fetch attempt itself gets a 401 back from
the server (the token looked valid client-side but was rejected
server-side -- clock skew, revocation, rotation race), force a REAL
refreshSession() round-trip and retry ONCE. Only after that second
attempt also fails does the signed-out message appear.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function _claireApi(body) {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) throw new Error('Supabase client not ready');
  // supabase-js's FunctionsHttpError ("Edge Function returned a non-2xx
  // status code") swallows the response body on non-2xx, so we can't
  // get to res.data.detail through the SDK. Use a raw fetch with the
  // current session's bearer token attached so we can read the real
  // upstream error verbatim — that's the only way to surface Anthropic's
  // explanation when the EF returns 502.
  var session;
  try { session = (await sb.auth.getSession()).data.session; } catch (e) {}
  if (!session || !session.access_token) {
    throw new Error('claire-chat: no active session (sign in again)');
  }
  // Resolve the project URL + anon key from the existing client config.
  // supabaseClient.supabaseUrl is exposed in v2.x; fall back to
  // window.SUPABASE_URL if a build redacts it.
  var supaUrl = (sb.supabaseUrl || window.SUPABASE_URL || '').replace(/\\/+$/, '');
  var anonKey = sb.supabaseKey || window.SUPABASE_ANON_KEY || '';
  var resp;
  try {
    resp = await fetch(supaUrl + '/functions/v1/claire-chat', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey':        anonKey,
      },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    throw new Error('claire-chat: network ' + (netErr.message || netErr));
  }
  var raw;"""

NEW = """// Claire auth-refresh fix: getSession() is cheap (no network) and
// usually enough, but a backgrounded iOS tab/PWA can suspend the SDK's
// own background refresh timer long enough that the cached session is
// stale by the time Claire is the first thing touched after returning.
// forceRefresh=true skips straight to a real refreshSession() round-
// trip instead, used both when getSession() itself comes back empty and
// as a one-time retry when the SERVER rejects a client-side-looking-
// valid token (a 401 despite getSession() being satisfied).
async function _claireGetSessionToken(sb, forceRefresh) {
  var session = null;
  if (forceRefresh) {
    try {
      var rr = await sb.auth.refreshSession();
      session = rr && rr.data && rr.data.session;
    } catch (e) {}
  }
  if (!session) {
    try { session = (await sb.auth.getSession()).data.session; } catch (e) {}
  }
  return (session && session.access_token) ? session : null;
}

async function _claireApi(body) {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) throw new Error('Supabase client not ready');
  // supabase-js's FunctionsHttpError ("Edge Function returned a non-2xx
  // status code") swallows the response body on non-2xx, so we can't
  // get to res.data.detail through the SDK. Use a raw fetch with the
  // current session's bearer token attached so we can read the real
  // upstream error verbatim — that's the only way to surface Anthropic's
  // explanation when the EF returns 502.
  // Resolve the project URL + anon key from the existing client config.
  // supabaseClient.supabaseUrl is exposed in v2.x; fall back to
  // window.SUPABASE_URL if a build redacts it.
  var supaUrl = (sb.supabaseUrl || window.SUPABASE_URL || '').replace(/\\/+$/, '');
  var anonKey = sb.supabaseKey || window.SUPABASE_ANON_KEY || '';

  async function doFetch(session) {
    return fetch(supaUrl + '/functions/v1/claire-chat', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey':        anonKey,
      },
      body: JSON.stringify(body),
    });
  }

  var session = await _claireGetSessionToken(sb, false);
  if (!session) {
    // getSession() came back with nothing at all -- force a real
    // refresh before giving up. This is the fix: the old code threw
    // "no active session" right here with zero retry.
    session = await _claireGetSessionToken(sb, true);
  }
  if (!session) {
    throw new Error('claire-chat: no active session (sign in again)');
  }

  var resp;
  try {
    resp = await doFetch(session);
  } catch (netErr) {
    throw new Error('claire-chat: network ' + (netErr.message || netErr));
  }

  if (resp.status === 401) {
    // The token looked valid client-side but the server rejected it
    // anyway (expiry/clock-skew/revocation/rotation race) -- force one
    // real refresh and retry once before surfacing a signed-out message.
    var refreshed = await _claireGetSessionToken(sb, true);
    if (!refreshed) {
      throw new Error('claire-chat: no active session (sign in again)');
    }
    try {
      resp = await doFetch(refreshed);
    } catch (netErr2) {
      throw new Error('claire-chat: network ' + (netErr2.message || netErr2));
    }
  }

  var raw;"""

EDITS = [("Claire auth-refresh fix: getSession + refreshSession-on-empty/401 + retry once", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
