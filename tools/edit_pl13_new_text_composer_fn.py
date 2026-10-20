#!/usr/bin/env python3
"""Manager-text-any-number feature. openNewTextComposer()/sendNewText()
-- same dynamic-modal pattern as openGeotabIntegrationSettings()/
openPayrollSettingsModal(). Explicitly passes allowUnknown: true (this
box genuinely is for texting a number that may not be a client or
employee yet) -- the real security boundary is now server-side (role),
this flag is just honest, self-documenting client code.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function matchClientByPhone(phone) {"""

NEW = """function openNewTextComposer() {
  var existing = document.getElementById('new-text-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'new-text-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:900;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = ''
    + '<div style="background:var(--surface);width:100%;max-width:420px;border-radius:14px;border:1px solid var(--border2);padding:22px">'
    +   '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    +     '<div style="font-size:17px;font-weight:700">✎ New text</div>'
    +     '<button type="button" onclick="document.getElementById(\\'new-text-overlay\\').remove()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);width:30px;height:30px;border-radius:50%;font-size:17px;cursor:pointer">×</button>'
    +   '</div>'
    +   '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Phone number</div>'
    +   '<input type="tel" id="new-text-phone" placeholder="(555) 555-5555" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:15px;padding:11px 14px;border-radius:8px;margin-bottom:14px;outline:none">'
    +   '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Message</div>'
    +   '<textarea id="new-text-message" rows="4" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:15px;padding:11px 14px;border-radius:8px;margin-bottom:14px;outline:none;resize:vertical"></textarea>'
    +   '<button type="button" id="new-text-send-btn" onclick="sendNewText()" style="width:100%;background:var(--accent);border:none;color:#fff;font-family:\\'DM Sans\\',sans-serif;font-size:14px;font-weight:700;padding:12px;border-radius:10px;cursor:pointer">Send</button>'
    +   '<div id="new-text-status" style="font-size:12px;min-height:18px;margin-top:10px"></div>'
    + '</div>';
  document.body.appendChild(overlay);
  setTimeout(function () { var el = document.getElementById('new-text-phone'); if (el) el.focus(); }, 50);
}

async function sendNewText() {
  var statusEl = document.getElementById('new-text-status');
  var btn = document.getElementById('new-text-send-btn');
  var phoneEl = document.getElementById('new-text-phone');
  var msgEl = document.getElementById('new-text-message');
  if (!phoneEl || !msgEl) return;
  var digits = (phoneEl.value || '').replace(/\\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length !== 10) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Enter a valid 10-digit phone number.'; }
    return;
  }
  var msg = (msgEl.value || '').trim();
  if (!msg) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Enter a message.'; }
    return;
  }
  var e164 = '+1' + digits;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = ''; }
  try {
    var res = await _sendSMS(e164, msg, { allowUnknown: true });
    if (res.kind === 'native') {
      var overlay = document.getElementById('new-text-overlay');
      if (overlay) overlay.remove();
      return; // the phone's own SMS app is now open; nothing left to confirm here
    }
    if (statusEl) { statusEl.style.color = 'var(--green)'; statusEl.textContent = 'Sent.'; }
    setTimeout(function () {
      var overlay2 = document.getElementById('new-text-overlay');
      if (overlay2) overlay2.remove();
      try { if (typeof loadInbox === 'function') loadInbox(); } catch (e) {}
    }, 700);
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Could not send: ' + ((e && e.message) || 'unknown error'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}

function matchClientByPhone(phone) {"""

EDITS = [("Messages screen: openNewTextComposer() + sendNewText()", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
