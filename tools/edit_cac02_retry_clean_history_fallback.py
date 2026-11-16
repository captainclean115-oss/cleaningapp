#!/usr/bin/env python3
"""Claire-ai-call-failing fix -- defensive robustness requested in
STEP 3 even though it was NOT the cause of this specific incident
(confirmed via logs to be an Anthropic billing/credits rejection, not
a malformed conversation history -- _claireSanitizeHistoryForApi
already repairs tool_use/tool_result pairing on every send).

If the SAME message fails twice in a row (the original send, then its
first retry), the second Retry tap falls back to a clean in-memory
history (and a fresh conversation id) before resending -- in case
*something* about the accumulated history was the real problem, not
just a transient failure. Tom's own visible chat transcript (the
bubbles already on screen) is left completely alone; only the array
actually sent to the API resets. A different, unrelated message that
later fails starts its own fresh 2-attempt count -- this never
confuses an old failed-and-abandoned message with a new one.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """var _claireLastFailedMessage = null;
function _claireReplyWithRetry(originalText) {
  _claireLastFailedMessage = originalText;
  claireHideTyping();
  if (_claireSilent) return;
  var html = 'I couldn\\'t reach my AI just now. Your message is saved.'
    + '<div style="margin-top:8px"><button type="button" onclick="_claireRetryFailedMessage()" style="padding:8px 14px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:600;cursor:pointer">Retry</button></div>';
  _claireRenderBubble('claire', html);
}
function _claireRetryFailedMessage() {
  var text = _claireLastFailedMessage;
  if (!text) return;
  _claireLastFailedMessage = null;
  claireShowTyping();
  processVoiceCommand(text);
}"""

NEW = """var _claireLastFailedMessage = null;
// Claire-ai-call-failing fix: tracks how many times the SAME message
// has failed in a row, and which message that count belongs to -- a
// different message failing later always starts its own count at 0,
// never inherits a stale count from an earlier, unrelated failure.
var _claireRetryAttemptCount = 0;
var _claireRetryTrackedText = null;
function _claireReplyWithRetry(originalText) {
  if (_claireRetryTrackedText !== originalText) {
    _claireRetryTrackedText = originalText;
    _claireRetryAttemptCount = 0;
  }
  _claireLastFailedMessage = originalText;
  claireHideTyping();
  if (_claireSilent) return;
  var html = 'I couldn\\'t reach my AI just now. Your message is saved.'
    + '<div style="margin-top:8px"><button type="button" onclick="_claireRetryFailedMessage()" style="padding:8px 14px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:600;cursor:pointer">Retry</button></div>';
  _claireRenderBubble('claire', html);
}
function _claireRetryFailedMessage() {
  var text = _claireLastFailedMessage;
  if (!text) return;
  _claireLastFailedMessage = null;
  _claireRetryAttemptCount++;
  if (_claireRetryAttemptCount >= 2) {
    // The same message has now failed twice in a row (original send +
    // one retry) -- fall back to a clean history + a fresh conversation
    // id before trying a third time, in case the accumulated history
    // itself was contributing. Tom's visible chat bubbles are untouched
    // -- only the in-memory array actually sent to the API resets.
    _claireHistory = [];
    _claireActiveConversationId = null;
    _claireRetryAttemptCount = 0;
    _claireRetryTrackedText = null;
  }
  claireShowTyping();
  processVoiceCommand(text);
}"""

EDITS = [
    ("Claire-ai-call-failing fix: Retry falls back to a clean history after 2 failed attempts", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
