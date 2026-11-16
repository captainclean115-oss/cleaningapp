#!/usr/bin/env python3
"""Claire-ai-call-failing fix.

REAL root cause (confirmed via claire-chat Edge Function logs, both
the 2026-11-13 11:32am and 12:56pm ET incidents): Anthropic itself is
rejecting every call with "Your credit balance is too low to access
the Anthropic API." -- a billing/credits problem on the Anthropic
account, not a bug in this app's code. Nothing to fix for the actual
cause (Tom/the business owner needs to add credits in the Anthropic
console).

Two real, in-our-code bugs found along the way, fixed here:

1. _claireUserFacingError's `invalid_request_error` regex is Anthropic's
   GENERIC "something about the request was invalid" error type --
   it covers many distinct causes (bad model, bad schema, malformed
   messages, AND insufficient credits), not specifically a broken
   tool_use/tool_result pairing. The old code mapped ALL of them to
   "I lost track -- can you resend your last request?", which is
   actively wrong for a credits problem: retrying can never fix it,
   and the message falsely implies a conversation-memory issue. Now a
   credit-balance message gets its own honest, specific translation,
   and the tool-pairing regex is narrowed to the phrases that actually
   mean a broken pairing -- a bare invalid_request_error with neither
   phrase gets a neutral "something about that request wasn't
   accepted" message instead of the misleading memory-loss one.

2. The last-error line (PR #232) was being set from the ALREADY
   user-facing-translated short string, so it told Tom nothing he
   couldn't already see in the chat bubble -- the whole point of a
   diagnostics line is to carry MORE detail than the friendly chat
   text. It now carries the raw HTTP status + the server's own error
   message (trimmed to ~150 chars), set at the two real failure call
   sites directly, before translation.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_TRANSLATOR = """function _claireUserFacingError(err) {
  if (err && err.isRateLimit) return 'Hit rate limit, slow down — try again in a few minutes.';
  var msg = String((err && err.message) || '');
  if (/no active session|sign in again/i.test(msg)) return 'You got signed out — sign back in and try again.';
  if (/network/i.test(msg)) return 'Connection dropped. Try again?';
  if (/unexpected tool_use_id|tool_use ids without tool_result|invalid_request_error/i.test(msg)) return 'I lost track — can you resend your last request?';
  if (/time(d)?[ -]?out/i.test(msg)) return 'That took too long. Try again?';"""

NEW_TRANSLATOR = """function _claireUserFacingError(err) {
  if (err && err.isRateLimit) return 'Hit rate limit, slow down — try again in a few minutes.';
  var msg = String((err && err.message) || '');
  if (/no active session|sign in again/i.test(msg)) return 'You got signed out — sign back in and try again.';
  if (/network/i.test(msg)) return 'Connection dropped. Try again?';
  // Claire-ai-call-failing fix: Anthropic's own billing/credits
  // rejection ("Your credit balance is too low...") is an
  // invalid_request_error too, but it is NEVER a conversation/memory
  // problem -- retrying can't fix it, and the old generic mapping
  // below falsely implied Claire "lost track." Checked first, with
  // its own honest, specific, actionable message.
  if (/credit balance is too low|insufficient[ _]?(credits?|quota|balance)|plans\\s*&\\s*billing/i.test(msg)) return 'Claire\\'s AI account is out of credits — ask the owner to check Anthropic billing before trying again.';
  // invalid_request_error is Anthropic's GENERIC "something about the
  // request was invalid" type -- covers many distinct causes, not
  // just a broken tool_use/tool_result pairing. Only the specific
  // pairing phrases get the "lost track" message now; any OTHER
  // invalid_request_error gets a neutral message instead of a false
  // memory-loss claim.
  if (/unexpected tool_use_id|tool_use ids without tool_result/i.test(msg)) return 'I lost track — can you resend your last request?';
  if (/invalid_request_error/i.test(msg)) return 'That request wasn\\'t accepted. Try again?';
  if (/time(d)?[ -]?out/i.test(msg)) return 'That took too long. Try again?';"""

OLD_INNER_CATCH = """        if (!didAnyToolCall) { processVoiceCommandLocal(text, _claireUserFacingError(claireErr)); return; }"""

NEW_INNER_CATCH = """        if (!didAnyToolCall) {
          _claireSetLastErrorNote(_claireRawErrorDetail(claireErr));
          processVoiceCommandLocal(text, _claireUserFacingError(claireErr));
          return;
        }"""

OLD_OUTER_CATCH = """    console.error('[claire] processVoiceCommand failed:', e && e.message, e);
    _claireLogTechnicalError('processVoiceCommand outer catch', e);
    _claireSilent = false;
    claireHideTyping();
    processVoiceCommandLocal(text, _claireUserFacingError(e));
  }
}"""

NEW_OUTER_CATCH = """    console.error('[claire] processVoiceCommand failed:', e && e.message, e);
    _claireLogTechnicalError('processVoiceCommand outer catch', e);
    _claireSilent = false;
    claireHideTyping();
    _claireSetLastErrorNote(_claireRawErrorDetail(e));
    processVoiceCommandLocal(text, _claireUserFacingError(e));
  }
}

// Claire-ai-call-failing fix: the RAW detail (HTTP status + the
// server's own error message, trimmed) for the last-error line in the
// Claire menu -- deliberately more detailed than the short, friendly
// chat-bubble text _claireUserFacingError produces, since the whole
// point of a diagnostics line is to carry what the chat bubble can't.
function _claireRawErrorDetail(err) {
  if (!err) return 'Unknown error.';
  var statusPrefix = (err.status != null) ? ('HTTP ' + err.status + ': ') : '';
  var msg = String(err.message || err);
  return (statusPrefix + msg).slice(0, 150);
}"""

OLD_SET_LAST_ERROR_IN_FALLBACK = """  _claireSetLastErrorNote(apiErrorReason);
  _claireReplyWithRetry(text);"""

NEW_SET_LAST_ERROR_IN_FALLBACK = """  // Claire-ai-call-failing fix: the richer raw detail is already set
  // by the real caller (processVoiceCommand's two catch blocks) before
  // this function ever runs -- setting it again here, from the
  // already-translated friendly apiErrorReason, would just overwrite
  // that detail with something less useful.
  _claireReplyWithRetry(text);"""

EDITS = [
    ("Claire-ai-call-failing fix: billing/credits gets its own honest message; invalid_request_error narrowed", OLD_TRANSLATOR, NEW_TRANSLATOR),
    ("Claire-ai-call-failing fix: round-0 failure sets the raw last-error detail before translating", OLD_INNER_CATCH, NEW_INNER_CATCH),
    ("Claire-ai-call-failing fix: outer catch sets the raw last-error detail + add _claireRawErrorDetail", OLD_OUTER_CATCH, NEW_OUTER_CATCH),
    ("Claire-ai-call-failing fix: stop overwriting the raw detail with the friendly reason in the fallback", OLD_SET_LAST_ERROR_IN_FALLBACK, NEW_SET_LAST_ERROR_IN_FALLBACK),
]

if __name__ == "__main__":
    apply_edits(EDITS)
