#!/usr/bin/env python3
"""Claire cleanup PART 4 fix-up: the "show a note only on real failure"
logic never actually fired, because _claireLoadLocalCopy already
catches its own exceptions internally and returns null -- the outer
catch(e2) this relied on could never be reached. Replaces it with an
explicit serverErrored flag (set true only for a genuine server error/
timeout, never for "no row yet -- brand new user") combined with
"did the local fallback actually produce something usable" -- the real
AND/OR this needed from the start.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function _claireOpenView() {
  if (_claireViewOpened) return;
  _claireViewOpened = true;
  var loadedFromServer = false;
  var session = _claireSessionInfo();
  try {
    if (!session.authUserId || !session.businessId) return;
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) return;

    var res = await Promise.race([
      sb.from('claire_chat_sessions').select('*').eq('user_id', session.authUserId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      new Promise(function (resolve) { setTimeout(function () { resolve({ __timedOut: true }); }, 6000); })
    ]);
    if (res && res.__timedOut) {
      console.warn('[claire] saved-conversation server read timed out -- falling back to local copy');
    } else if (!res.error && res.data) {
      var ageMs = Date.now() - new Date(res.data.updated_at).getTime();
      if (ageMs <= 12 * 60 * 60 * 1000) {
        var original = Array.isArray(res.data.messages) ? res.data.messages : [];
        var repaired = _claireSanitizeMessagesArray(original);
        if (repaired.length || !original.length) {
          _claireApplyLoadedConversation(res.data.id, repaired);
        } else {
          // Had messages but repair dropped every single one -- genuinely
          // unrepairable. Start fresh and say so plainly rather than
          // silently replaying nothing.
          _claireActiveConversationId = null;
          _claireHistory = [];
          _claireRenderSystemNote('Started a new conversation.');
        }
        loadedFromServer = true;
      } else {
        // Stale (>12h) -- an intentional fresh start, not a failure.
        // Leave _claireActiveConversationId null and _claireHistory
        // empty; claireEnsureIntro's normal first-message greeting
        // fires as usual. The next save creates a NEW row rather than
        // overwriting the stale one. Don't fall back to a (likely also
        // stale) local copy here either.
        loadedFromServer = true;
      }
    }
    // else: no row at all (brand new user) -- not an error, just
    // nothing to load yet. Falls through to the local-fallback check
    // below, which will also correctly find nothing and do nothing.
  } catch (e) {
    console.warn('[claire] failed to load saved conversation from server:', e);
  }

  if (!loadedFromServer) {
    try {
      var local = (session.businessId && session.authUserId) ? _claireLoadLocalCopy(session.businessId, session.authUserId) : null;
      if (local && local.messages && local.messages.length) {
        var ageMsLocal = Date.now() - new Date(local.updatedAt).getTime();
        if (ageMsLocal <= 12 * 60 * 60 * 1000) {
          var repairedLocal = _claireSanitizeMessagesArray(local.messages);
          if (repairedLocal.length) {
            // Local copy has no row id (it was never confirmed to reach
            // the server) -- next save creates a fresh server row.
            _claireApplyLoadedConversation(null, repairedLocal);
          }
        }
      }
    } catch (e2) {
      // Both the server AND the local fallback failed -- this is the one
      // case that's a genuine, visible failure.
      console.warn('[claire] local fallback also failed:', e2);
      _claireRenderSystemNote(_claireUserFacingError(new Error('claire_chat_sessions load failed: ' + ((e2 && e2.message) || e2))));
    }
  }"""

NEW = """async function _claireOpenView() {
  if (_claireViewOpened) return;
  _claireViewOpened = true;
  var loadedFromServer = false;
  // True ONLY for a genuine server error or timeout -- never for "no row
  // yet" (a brand new user, not a failure). Combined with "did the local
  // fallback actually produce something usable" below to decide whether
  // this is the one case that shows a visible note.
  var serverErrored = false;
  var session = _claireSessionInfo();
  try {
    if (!session.authUserId || !session.businessId) return;
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) return;

    var res = await Promise.race([
      sb.from('claire_chat_sessions').select('*').eq('user_id', session.authUserId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      new Promise(function (resolve) { setTimeout(function () { resolve({ __timedOut: true }); }, 6000); })
    ]);
    if (res && res.__timedOut) {
      serverErrored = true;
      console.warn('[claire] saved-conversation server read timed out -- falling back to local copy');
    } else if (res && res.error) {
      serverErrored = true;
    } else if (res && res.data) {
      var ageMs = Date.now() - new Date(res.data.updated_at).getTime();
      if (ageMs <= 12 * 60 * 60 * 1000) {
        var original = Array.isArray(res.data.messages) ? res.data.messages : [];
        var repaired = _claireSanitizeMessagesArray(original);
        if (repaired.length || !original.length) {
          _claireApplyLoadedConversation(res.data.id, repaired);
        } else {
          // Had messages but repair dropped every single one -- genuinely
          // unrepairable. Start fresh and say so plainly rather than
          // silently replaying nothing.
          _claireActiveConversationId = null;
          _claireHistory = [];
          _claireRenderSystemNote('Started a new conversation.');
        }
        loadedFromServer = true;
      } else {
        // Stale (>12h) -- an intentional fresh start, not a failure.
        // Leave _claireActiveConversationId null and _claireHistory
        // empty; claireEnsureIntro's normal first-message greeting
        // fires as usual. The next save creates a NEW row rather than
        // overwriting the stale one. Don't fall back to a (likely also
        // stale) local copy here either.
        loadedFromServer = true;
      }
    }
    // else: res.data is null with no error -- genuinely no row yet (a
    // brand new user). Not a failure. Falls through below, where the
    // local-fallback check will also correctly find nothing and do
    // nothing -- no note, no error, just a normal fresh start.
  } catch (e) {
    serverErrored = true;
    console.warn('[claire] failed to load saved conversation from server:', e);
  }

  if (!loadedFromServer) {
    var usedLocal = false;
    var local = null;
    try {
      local = (session.businessId && session.authUserId) ? _claireLoadLocalCopy(session.businessId, session.authUserId) : null;
    } catch (e2) {
      local = null;
    }
    if (local && local.messages && local.messages.length) {
      var ageMsLocal = Date.now() - new Date(local.updatedAt).getTime();
      if (ageMsLocal <= 12 * 60 * 60 * 1000) {
        var repairedLocal = _claireSanitizeMessagesArray(local.messages);
        if (repairedLocal.length) {
          // Local copy has no row id (it was never confirmed to reach
          // the server) -- next save creates a fresh server row.
          _claireApplyLoadedConversation(null, repairedLocal);
          usedLocal = true;
        }
      }
    }
    if (!usedLocal && serverErrored) {
      // The server genuinely errored/timed out AND there was nothing
      // usable to fall back to locally either -- the one case that's a
      // real, visible failure. A brand-new user with no history anywhere
      // (serverErrored false) never reaches this branch.
      _claireRenderSystemNote(_claireUserFacingError(new Error('claire_chat_sessions load failed: server and local fallback both unavailable')));
    }
  }"""

EDITS = [("Claire cleanup PART 4 fix-up: correct genuine-failure detection (serverErrored + no usable local copy)", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
