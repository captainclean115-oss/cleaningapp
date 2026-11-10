#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 4 core module.
Saved conversations: redaction, turn-boundary trim (distinct from the
live, array-index _claireTrimHistory), whole-turn save, load-on-open
(most recent conversation or fresh if >12h stale, with sanitize-on-load
repair), New Chat / Clear History, and loading pending proposal cards
into the chat on open (STEP 3F "survives reload").
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function claireEnsureIntro() {"""

NEW = """// -----------------------------------------------------------------------
// CLAIRE SAFETY FOUNDATION (Stage 2a) -- saved conversations.
// Persisted to claire_chat_sessions at WHOLE-TURN granularity only -- the
// two _claireSaveConversationTurn() call sites in processVoiceCommand
// are both turn boundaries where every tool_use already has its
// tool_result (see _claireSanitizeMessagesArray). One row per user per
// business; loaded on opening Claire, trimmed to the last 20 turns
// before saving (turn-boundary trim, never a raw array slice).
// -----------------------------------------------------------------------
var _claireActiveConversationId = null; // claire_chat_sessions.id once a row exists for this user
var _claireViewOpened = false;          // guards the one-time load-on-open per page load

// Tools whose tool_result must never be written to a saved row -- pay
// amounts and payment/financial detail stay in the live session only.
var CLAIRE_SENSITIVE_SAVE_REDACT = {
  change_price: 1, record_payment: 1, edit_employee_hours: 1,
  batch_edit_employee_hours: 1, lookup_balance: 1, get_revenue: 1
};

// Walks an already-sanitized, well-paired messages array and blanks the
// tool_result content for any tool in CLAIRE_SENSITIVE_SAVE_REDACT.
// Matches a tool_result to its tool via the preceding assistant
// tool_use message's id -> name map.
function _claireRedactForSave(messages) {
  var idToName = {};
  var i, j;
  for (i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m && m.role === 'assistant' && Array.isArray(m.content)) {
      for (j = 0; j < m.content.length; j++) {
        var b = m.content[j];
        if (b && b.type === 'tool_use') idToName[b.id] = b.name;
      }
    }
  }
  return messages.map(function(m) {
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) return m;
    var changed = false;
    var newContent = m.content.map(function(b) {
      if (b && b.type === 'tool_result' && CLAIRE_SENSITIVE_SAVE_REDACT[idToName[b.tool_use_id]]) {
        changed = true;
        return Object.assign({}, b, { content: '[omitted from saved history]' });
      }
      return b;
    });
    return changed ? Object.assign({}, m, { content: newContent }) : m;
  });
}

// Turn-boundary trim for the SAVED copy -- deliberately separate from
// the live, array-index-based _claireTrimHistory (that one still
// controls what's sent to the model mid-conversation; this one only
// decides how much history a saved row retains). A "turn" starts at a
// plain-string user message, same definition _claireSanitizeMessagesArray
// already uses for a genuine boundary.
function _claireTrimToLastNTurns(messages, n) {
  var boundaries = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') boundaries.push(i);
  }
  if (boundaries.length <= n) return messages.slice();
  return messages.slice(boundaries[boundaries.length - n]);
}

// Small, visually distinct note -- NOT spoken as Claire ("Started a new
// conversation", "Could not save this conversation"). Centered, muted,
// no avatar, so it never reads as something Claire said.
function _claireRenderSystemNote(text) {
  var box = _claireMsgsEl();
  if (!box) return;
  var row = document.createElement('div');
  row.className = 'claire-msg-row';
  row.innerHTML = '<div style="width:100%;text-align:center;font-size:11px;color:var(--muted);font-style:italic;padding:6px 0">' + String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>';
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// Whole-turn save. Called ONLY from the two turn-boundary exit points in
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
  } catch (e) {
    // STEP 4E: a failed save never blocks Claire -- small visible note, nothing more.
    console.warn('[claire] failed to save conversation:', e);
    _claireRenderSystemNote('Could not save this conversation.');
  }
}

// Renders a loaded (already sanitized) messages array as the visible
// transcript Tom actually saw -- only the final text of each turn was
// ever shown originally (the tool-use loop runs silently), so a bare
// assistant message with tool_use blocks and no text contributes
// nothing here either, same as the first time.
function _claireRenderHistoryTranscript(messages) {
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m) continue;
    if (m.role === 'user' && typeof m.content === 'string') {
      _claireRenderBubble('user', m.content);
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      var text = m.content.filter(function(b){ return b && b.type === 'text'; }).map(function(b){ return b.text; }).join('');
      if (text) _claireRenderBubble('claire', text);
    }
  }
}

// Renders a card for every pending proposal visible to the signed-in
// user (RLS does the real scoping). STEP 3F: proposals survive reload.
async function _claireLoadPendingProposalsIntoChat() {
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) return;
    var res = await sb.from('claire_proposals').select('*').eq('status', 'pending').order('created_at', { ascending: true });
    if (res.error || !res.data || !res.data.length) return;
    for (var i = 0; i < res.data.length; i++) {
      _claireRenderBubble('claire', _claireProposalCardHtml(res.data[i]));
    }
  } catch (e) { console.warn('[claire] failed to load pending proposals:', e); }
}

// On opening Claire: load the most recent saved conversation (or start
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
  }
  _claireLoadPendingProposalsIntoChat();
}

// "New chat" button -- starts a fresh conversation without touching any
// saved row (the old one stays saved; the next turn creates a new row).
function _claireStartNewChat() {
  _claireHistory = [];
  _claireActiveConversationId = null;
  var box = _claireMsgsEl();
  if (box) { box.innerHTML = ''; box.dataset.inited = ''; }
  claireEnsureIntro();
}

// "Clear history" button -- deletes ONLY the current user's saved rows.
// RLS already enforces this on its own; the .eq is belt-and-suspenders,
// never the only thing standing between this and someone else's rows.
async function _claireClearHistory() {
  if (!window.confirm('Delete all of your saved Claire conversations? This cannot be undone.')) return;
  try {
    var session = _claireSessionInfo();
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb || !session.authUserId) return;
    await sb.from('claire_chat_sessions').delete().eq('user_id', session.authUserId);
  } catch (e) {
    console.warn('[claire] failed to clear history:', e);
  }
  _claireStartNewChat();
}

function claireEnsureIntro() {"""

EDITS = [("Claire: saved-conversations core module (save/load/redact/trim/new-chat/clear-history)", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
