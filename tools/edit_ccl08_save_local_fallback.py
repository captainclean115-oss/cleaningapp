#!/usr/bin/env python3
"""Claire cleanup PART 4: WHY THE THREAD VANISHED.

Diagnosis: claire_chat_sessions had ZERO rows in the live database --
confirmed via a direct read-only count query -- despite claire_proposals
(created via the exact same session-info/business-id derivation)
having real rows. The save call _claireSaveConversationTurn() was never
awaited at either of its two call sites in processVoiceCommand -- a
fire-and-forget network write. The most common thing a person does
right after getting Claire's reply is exactly what breaks this: leave
the screen (switch apps, background, close the tab) -- and an
unawaited fetch/XHR that hasn't completed when the page navigates away
or the tab backgrounds under memory pressure can be cancelled by the
browser before Supabase ever receives it. That is a plausible, complete
explanation for BOTH symptoms with one root cause: the save never
reliably finished, so there was never anything to restore.

Fix, two layers:
  1. Await both call sites (the two-line fix the hard rule already
     calls out: "Await all async calls").
  2. Defense in depth -- write a LOCAL (localStorage) fallback copy
     SYNCHRONOUSLY, before the network call, so even a save whose
     network leg genuinely never completes (slow connection, a
     navigation that's faster than this fix can prevent, airplane
     mode) still leaves something to restore from. Keyed per
     business+user, same redaction as the server copy (no sensitive
     tool results).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// Whole-turn save. Called ONLY from the two turn-boundary exit points in
// processVoiceCommand (the normal text-reply return, and the
// MAX_TOOL_ROUNDS wrap-up) -- both are points where _claireHistory's
// last entry already has every tool_use paired with its tool_result,
// never a dangling one.
async function _claireSaveConversationTurn() {
  try {
    var session = _claireSessionInfo();
    if (!session.authUserId || !session.businessId) return;
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) return;

    var sanitized = _claireSanitizeMessagesArray(_claireHistory);
    var trimmed = _claireTrimToLastNTurns(sanitized, 20);
    var redacted = _claireRedactForSave(trimmed);

    if (_claireActiveConversationId) {
      var upd = await sb.from('claire_chat_sessions').update({
        messages: redacted, message_count: redacted.length, updated_at: new Date().toISOString()
      }).eq('id', _claireActiveConversationId);
      if (upd.error) throw new Error(upd.error.message);
    } else {
      var ins = await sb.from('claire_chat_sessions').insert({
        business_id: session.businessId, user_id: session.authUserId,
        messages: redacted, message_count: redacted.length
      }).select().single();
      if (ins.error) throw new Error(ins.error.message);
      _claireActiveConversationId = ins.data.id;
    }
  } catch (e) {"""

NEW = """// Local (localStorage) fallback copy of the current conversation --
// written SYNCHRONOUSLY (no network, can't be cancelled by a
// navigation/background event) on every save attempt, before the
// server write even starts. Keyed per business+user. Same redaction
// as the server copy -- never holds sensitive tool results.
function _claireLocalConvKey(businessId, userId) {
  return 'claire_local_conv_' + businessId + '_' + userId;
}
function _claireSaveLocalCopy(businessId, userId, messages) {
  try {
    window.localStorage.setItem(_claireLocalConvKey(businessId, userId), JSON.stringify({ messages: messages, updatedAt: new Date().toISOString() }));
  } catch (e) {
    // Best-effort only -- private browsing / quota exceeded / storage
    // disabled must never block Claire. The server save (above/below
    // this call) is unaffected by a local-storage failure.
    console.warn('[claire] local fallback copy failed:', e);
  }
}
function _claireLoadLocalCopy(businessId, userId) {
  try {
    var raw = window.localStorage.getItem(_claireLocalConvKey(businessId, userId));
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages) || !parsed.updatedAt) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

// Whole-turn save. Called (and AWAITED -- a past bug here was an
// unawaited fire-and-forget call at both call sites, letting the very
// next thing a person naturally does after getting a reply -- leave
// the screen -- race the in-flight network write and lose it, every
// time; see this function's own local-fallback-copy step below for the
// defense-in-depth half of that fix) from the two turn-boundary exit
// points in processVoiceCommand (the normal text-reply return, and the
// MAX_TOOL_ROUNDS wrap-up) -- both are points where _claireHistory's
// last entry already has every tool_use paired with its tool_result,
// never a dangling one.
async function _claireSaveConversationTurn() {
  try {
    var session = _claireSessionInfo();
    if (!session.authUserId || !session.businessId) return;

    var sanitized = _claireSanitizeMessagesArray(_claireHistory);
    var trimmed = _claireTrimToLastNTurns(sanitized, 20);
    var redacted = _claireRedactForSave(trimmed);

    // Local copy FIRST, synchronously -- immune to the network leg
    // below being cancelled by a page navigation/background that
    // happens right after this turn.
    _claireSaveLocalCopy(session.businessId, session.authUserId, redacted);

    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) return;

    if (_claireActiveConversationId) {
      var upd = await sb.from('claire_chat_sessions').update({
        messages: redacted, message_count: redacted.length, updated_at: new Date().toISOString()
      }).eq('id', _claireActiveConversationId);
      if (upd.error) throw new Error(upd.error.message);
    } else {
      var ins = await sb.from('claire_chat_sessions').insert({
        business_id: session.businessId, user_id: session.authUserId,
        messages: redacted, message_count: redacted.length
      }).select().single();
      if (ins.error) throw new Error(ins.error.message);
      _claireActiveConversationId = ins.data.id;
    }
  } catch (e) {"""

EDITS = [("Claire cleanup PART 4: local fallback copy + hardened save function", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
