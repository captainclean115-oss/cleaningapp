#!/usr/bin/env python3
"""Claire-draft-and-fallback fix -- PART A.

BUG (Tom, phone, Nov 13 ~11:32am ET): asked Claire to draft a text to
a client about an unpaid balance. The Anthropic call failed with a
conversation-history-shaped error, processVoiceCommandLocal's keyword
branches (schedule/cancel/uncancel/day off/remind) correctly found
nothing to match a drafting request, and the FINAL catch-all --
unconditionally -- appended "Try: Schedule [name] [day] [time] [team]
or Cancel [name] [day]" regardless of what Tom actually asked for.
That generic template is the bug: it's only ever honest for a
schedule/cancel-shaped message, never for anything else a real server
failure interrupted.

Fix: the catch-all stops pretending it understood a schedule-shaped
request. It now shows a plain, honest "couldn't reach my AI" message
with a working Retry button that resends the exact same text (stored,
never discarded), and logs the failure reason to a small "last error"
line in the Claire menu so Tom can see why without opening devtools.
Every keyword-recognized branch above this one is completely
unaffected -- this only changes what happens when NONE of them match.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  claireReply((apiErrorReason || 'Sorry, I\\'m having trouble connecting right now.')
    + ' Try: "Schedule [name] [day] [time] [team]" or "Cancel [name] [day]".');
}

function cancelVoiceCmd() {"""

NEW = """  _claireSetLastErrorNote(apiErrorReason);
  _claireReplyWithRetry(text);
}

// Claire-draft-and-fallback fix: the message that couldn't be handled
// (server failed AND no local keyword matched it) is preserved --
// never discarded -- so Retry can resend EXACTLY what Tom asked,
// instead of making him retype it.
var _claireLastFailedMessage = null;
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
}

// Claire-draft-and-fallback fix: a short, visible "what went wrong
// last time" line in the Claire menu (the "..." sheet) -- so Tom can
// check why a message failed without opening devtools. Best-effort,
// never throws; persisted to localStorage so it survives a reload.
function _claireSetLastErrorNote(reasonText) {
  try {
    localStorage.setItem('claire_last_error', JSON.stringify({
      when: new Date().toISOString(),
      message: reasonText || 'Could not reach the AI.'
    }));
  } catch (e) {}
  _claireRenderLastErrorLine();
}
function _claireRenderLastErrorLine() {
  var el = document.getElementById('claire-last-error-line');
  if (!el) return;
  try {
    var raw = localStorage.getItem('claire_last_error');
    if (!raw) { el.textContent = ''; return; }
    var entry = JSON.parse(raw);
    var when = new Date(entry.when).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    el.textContent = 'Last error: ' + when + ' — ' + entry.message;
  } catch (e) { el.textContent = ''; }
}

function cancelVoiceCmd() {"""

EDITS = [
    ("Claire-draft-and-fallback fix: honest retry fallback replaces the schedule-only template", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
