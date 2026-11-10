#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 5.
Adds the saved-conversation-load case to the existing
_claireUserFacingError mapping (keeping every existing branch, including
"I lost track"), and routes _claireOpenView's load failure through it so
a genuine load failure (not a corruption-repair case, which already has
its own "Started a new conversation" note) gets the same plain-English,
visible-but-non-blocking treatment. No model, max_tokens, or Edge
Function change.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_MAPPING = """function _claireUserFacingError(err) {
  if (err && err.isRateLimit) return 'Hit rate limit, slow down — try again in a few minutes.';
  var msg = String((err && err.message) || '');
  if (/no active session|sign in again/i.test(msg)) return 'You got signed out — sign back in and try again.';
  if (/network/i.test(msg)) return 'Connection dropped. Try again?';
  if (/unexpected tool_use_id|tool_use ids without tool_result|invalid_request_error/i.test(msg)) return 'I lost track — can you resend your last request?';
  if (/time(d)?[ -]?out/i.test(msg)) return 'That took too long. Try again?';
  return 'Something went wrong. Try again?';
}"""

NEW_MAPPING = """function _claireUserFacingError(err) {
  if (err && err.isRateLimit) return 'Hit rate limit, slow down — try again in a few minutes.';
  var msg = String((err && err.message) || '');
  if (/no active session|sign in again/i.test(msg)) return 'You got signed out — sign back in and try again.';
  if (/network/i.test(msg)) return 'Connection dropped. Try again?';
  if (/unexpected tool_use_id|tool_use ids without tool_result|invalid_request_error/i.test(msg)) return 'I lost track — can you resend your last request?';
  if (/time(d)?[ -]?out/i.test(msg)) return 'That took too long. Try again?';
  // Claire safety foundation (Stage 2a): a saved-conversation load
  // failure (network/DB, not a corrupted-history repair -- that case
  // already shows its own "Started a new conversation" note). Continuing
  // without the saved history is always safe -- this is informational,
  // never blocking.
  if (/claire_chat_sessions/i.test(msg)) return 'Couldn\\'t load your saved conversation — continuing fresh.';
  return 'Something went wrong. Try again?';
}"""

OLD_CATCH = """  } catch (e) {
    console.warn('[claire] failed to load saved conversation:', e);
  }
  _claireLoadPendingProposalsIntoChat();
}"""

NEW_CATCH = """  } catch (e) {
    console.warn('[claire] failed to load saved conversation:', e);
    _claireRenderSystemNote(_claireUserFacingError(new Error('claire_chat_sessions load failed: ' + ((e && e.message) || e))));
  }
  _claireLoadPendingProposalsIntoChat();
}"""

EDITS = [
    ("Claire: add the saved-conversation case to _claireUserFacingError", OLD_MAPPING, NEW_MAPPING),
    ("Claire: route _claireOpenView's load failure through the plain-English mapper", OLD_CATCH, NEW_CATCH),
]

if __name__ == "__main__":
    apply_edits(EDITS)
