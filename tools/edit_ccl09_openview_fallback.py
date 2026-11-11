#!/usr/bin/env python3
"""Claire cleanup PART 4: _claireOpenView falls back to the local copy
when the server read is slow (bounded to 6s), errors, or simply hasn't
replicated yet -- "a slow or failed server load still shows the
thread." A visible note only appears when BOTH the server AND the
local fallback come up empty (a genuine real failure), never just for
using the fallback silently and successfully.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// On opening Claire: load the most recent saved conversation (or start
// fresh if none exist, or if the most recent is stale -- older than
// 12h), then load pending proposal cards. Runs once per page load
// (later tab visits are no-ops) -- mirrors claireEnsureIntro's own
// once-only dataset.inited guard.
async function _claireOpenView() {
  if (_claireViewOpened) return;
  _claireViewOpened = true;
  try {
    var session = _claireSessionInfo();
    if (!session.authUserId || !session.businessId) return;
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) return;

    var res = await sb.from('claire_chat_sessions').select('*').eq('user_id', session.authUserId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!res.error && res.data) {
      var ageMs = Date.now() - new Date(res.data.updated_at).getTime();
      if (ageMs <= 12 * 60 * 60 * 1000) {
        var original = Array.isArray(res.data.messages) ? res.data.messages : [];
        var repaired = _claireSanitizeMessagesArray(original);
        if (repaired.length || !original.length) {
          _claireHistory = repaired;
          _claireActiveConversationId = res.data.id;
          var box = _claireMsgsEl();
          // Suppress the generic first-message greeting -- we're resuming
          // a real conversation, not starting fresh.
          if (box) box.dataset.inited = '1';
          _claireRenderHistoryTranscript(repaired);
        } else {
          // Had messages but repair dropped every single one -- genuinely
          // unrepairable. Start fresh and say so plainly rather than
          // silently replaying nothing.
          _claireActiveConversationId = null;
          _claireHistory = [];
          _claireRenderSystemNote('Started a new conversation.');
        }
      }
      // else: stale (>12h) -- leave _claireActiveConversationId null and
      // _claireHistory empty; claireEnsureIntro's normal first-message
      // greeting fires as usual. The next save creates a NEW row rather
      // than overwriting the stale one.
    }
  } catch (e) {
    console.warn('[claire] failed to load saved conversation:', e);
    _claireRenderSystemNote(_claireUserFacingError(new Error('claire_chat_sessions load failed: ' + ((e && e.message) || e))));
  }
  await _claireLoadPendingProposalsIntoChat();
}"""

NEW = """// Renders a loaded-and-repaired messages array as the resumed
// conversation -- the shared tail end of both the server path and the
// local-fallback path in _claireOpenView below, so the two never drift.
function _claireApplyLoadedConversation(conversationId, repaired) {
  _claireHistory = repaired;
  _claireActiveConversationId = conversationId;
  var box = _claireMsgsEl();
  // Suppress the generic first-message greeting -- we're resuming a
  // real conversation, not starting fresh.
  if (box) box.dataset.inited = '1';
  _claireRenderHistoryTranscript(repaired);
}

// On opening Claire: load the most recent saved conversation (or start
// fresh if none exist, or if the most recent is stale -- older than
// 12h), then load pending proposal cards. Runs once per page load
// (later tab visits are no-ops) -- mirrors claireEnsureIntro's own
// once-only dataset.inited guard.
//
// Server read is bounded to 6s -- a slow connection falls back to the
// local copy (_claireSaveLocalCopy, written synchronously on every
// save) instead of leaving Tom staring at an empty Claire. A visible
// note only appears if BOTH the server AND the local fallback come up
// empty -- using the fallback silently and successfully is not a
// failure.
async function _claireOpenView() {
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
  }

  await _claireLoadPendingProposalsIntoChat();
}"""

EDITS = [("Claire cleanup PART 4: _claireOpenView bounded server read + local fallback", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
