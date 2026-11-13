#!/usr/bin/env python3
"""Claire-draft-and-fallback fix -- PART B. claireReply() renders a
drafted message (wrapped in a plain ``` fenced block per the new
DRAFTING system-prompt instruction) as its own copyable block with a
Copy button, instead of the fence markers showing up literally in
voice-mode plain text. Every other reply (no fence present) renders
exactly as before -- this is additive, not a rewrite of claireReply's
existing behavior.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function claireReply(msg, mode) {
  claireHideTyping();
  if (_claireSilent) return;
  // Research mode: render markdown structure (headers, bullets, paragraphs).
  // Voice mode (default): plain text passthrough — existing behavior preserved.
  var html = (mode === 'research') ? _claireMarkdownToHtml(msg) : msg;
  _claireRenderBubble('claire', html);
  claireSpeak(msg);  // _claireStripForSpeech inside already strips markdown for TTS
}"""

NEW = """function claireReply(msg, mode) {
  claireHideTyping();
  if (_claireSilent) return;
  // Research mode: render markdown structure (headers, bullets, paragraphs).
  // Voice mode (default): plain text passthrough — existing behavior preserved.
  var html = (mode === 'research') ? _claireMarkdownToHtml(msg) : _claireRenderDraftBlock(msg);
  _claireRenderBubble('claire', html);
  claireSpeak(msg);  // _claireStripForSpeech inside already strips markdown for TTS
}

// Claire-draft-and-fallback fix: a drafted message/text/email/note is
// wrapped in a plain ``` fenced block per the DRAFTING system-prompt
// instruction -- rendered as its own copyable block with a Copy
// button (the exact text Tom would paste elsewhere; Claire never
// sends it herself). Any reply with no fence passes through
// unchanged, byte-for-byte, exactly like before this fix.
function _claireRenderDraftBlock(msg) {
  var m = /```([\\s\\S]*?)```/.exec(String(msg == null ? '' : msg));
  if (!m) return msg;
  var before = msg.slice(0, m.index).trim();
  var after = msg.slice(m.index + m[0].length).trim();
  var draftText = m[1].replace(/^\\n/, '').replace(/\\n$/, '');
  var draftId = 'claire-draft-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return (before ? '<div style="margin-bottom:8px">' + _claireEscapeHtml(before) + '</div>' : '')
    + '<div id="' + draftId + '" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px;white-space:pre-wrap;font-size:13px;line-height:1.5">' + _claireEscapeHtml(draftText) + '</div>'
    + '<button type="button" onclick="_claireCopyDraft(\\'' + draftId + '\\')" style="margin-top:8px;padding:8px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:12px;font-weight:600;cursor:pointer">Copy</button>'
    + (after ? '<div style="margin-top:8px">' + _claireEscapeHtml(after) + '</div>' : '');
}

function _claireCopyDraft(id) {
  try {
    var el = document.getElementById(id);
    if (!el) return;
    var text = el.textContent || '';
    var done = function () { try { if (typeof showToast === 'function') showToast('Copied', 'success'); } catch (e) {} };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { _claireFallbackCopy(text, done); });
    } else {
      _claireFallbackCopy(text, done);
    }
  } catch (e) { console.warn('[claire] copy draft failed', e); }
}

// Pre-clipboard-API fallback (older iOS Safari/PWA) -- a temporary,
// off-screen, selected textarea + execCommand('copy'), same technique
// used broadly for "copy to clipboard" buttons before the async API.
function _claireFallbackCopy(text, done) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (done) done();
  } catch (e) { console.warn('[claire] fallback copy failed', e); }
}"""

EDITS = [
    ("Claire-draft-and-fallback fix: render a fenced draft block with a Copy button", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
