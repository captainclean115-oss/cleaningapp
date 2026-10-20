#!/usr/bin/env python3
"""Server-side invites feature. openBulkInviteModal()/sendBulkInvites()
-- lists every active employee with a phone who is not yet active
(no auth_user_id), skips missing/duplicate phones with a visible reason,
caps selection at 10, sends one at a time with a short delay so "Sending
N of M" is actually readable, never stops on one failure, ends with a
sent/failed summary with reasons. Calls the SAME send-invite Edge
Function pentaSendInvite uses -- no separate send path.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function matchClientByPhone(phone) {"""

NEW = """var _bulkInviteSending = false;

function _bulkNormPhone(raw) {
  var d = String(raw || '').replace(/\\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : null;
}

function openBulkInviteModal() {
  var existing = document.getElementById('bulk-invite-overlay');
  if (existing) existing.remove();

  var list = (window.PentaEmployees && window.PentaEmployees.listSync) ? window.PentaEmployees.listSync() : [];
  var phoneCounts = {};
  list.forEach(function (e) {
    if (e.status !== 'active') return;
    var n = _bulkNormPhone(e.phone);
    if (n) phoneCounts[n] = (phoneCounts[n] || 0) + 1;
  });

  var eligible = [];
  var skipped = [];
  list.forEach(function (e) {
    if (e.status !== 'active') return;
    if (e.auth_user_id) return; // already linked -- not a bulk-invite target
    var n = _bulkNormPhone(e.phone);
    if (!n) { skipped.push({ name: e.name, reason: 'no phone on file' }); return; }
    if (phoneCounts[n] > 1) { skipped.push({ name: e.name, reason: 'phone shared with another active employee' }); return; }
    eligible.push({ id: e.id, name: e.name, phone: e.phone });
  });

  var rowsHtml = eligible.map(function (e, i) {
    var checked = i < 10 ? 'checked' : '';
    return '<label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">'
      + '<input type="checkbox" class="bulk-invite-check" value="' + e.id + '" ' + checked + ' onchange="_bulkInviteCapCheck(this)">'
      + '<span style="flex:1">' + _adminEsc(e.name) + '</span>'
      + '<span style="font-size:11px;color:var(--muted)">' + _adminEsc(e.phone) + '</span>'
      + '</label>';
  }).join('');

  var skippedHtml = skipped.length
    ? '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--muted)">'
      + '<div style="font-weight:700;margin-bottom:4px">Skipped (' + skipped.length + ')</div>'
      + skipped.map(function (s) { return _adminEsc(s.name) + ' — ' + s.reason; }).join('<br>')
      + '</div>'
    : '';

  var overlay = document.createElement('div');
  overlay.id = 'bulk-invite-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:900;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = ''
    + '<div style="background:var(--surface);width:100%;max-width:480px;max-height:85vh;overflow-y:auto;border-radius:14px;border:1px solid var(--border2);padding:22px">'
    +   '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'
    +     '<div style="font-size:17px;font-weight:700">✉️ Bulk invite</div>'
    +     '<button type="button" onclick="document.getElementById(\\'bulk-invite-overlay\\').remove()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);width:30px;height:30px;border-radius:50%;font-size:17px;cursor:pointer">×</button>'
    +   '</div>'
    +   (eligible.length
          ? '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Up to 10 at a time. ' + eligible.length + ' eligible (active, has a phone, not yet linked).</div>'
            + '<div id="bulk-invite-list">' + rowsHtml + '</div>'
          : '<div style="font-size:13px;color:var(--muted);padding:16px 0">No eligible employees right now -- everyone active either already has a login or has no phone/a shared phone on file.</div>')
    + skippedHtml
    +   '<button type="button" id="bulk-invite-send-btn" onclick="sendBulkInvites()" ' + (eligible.length ? '' : 'disabled') + ' style="width:100%;margin-top:16px;background:var(--accent);border:none;color:#fff;font-family:\\'DM Sans\\',sans-serif;font-size:14px;font-weight:700;padding:12px;border-radius:10px;cursor:pointer">Send invites to selected</button>'
    +   '<div id="bulk-invite-progress" style="font-size:12px;color:var(--muted);margin-top:10px;min-height:18px"></div>'
    +   '<div id="bulk-invite-summary" style="font-size:12px;margin-top:6px;max-height:160px;overflow-y:auto"></div>'
    + '</div>';
  document.body.appendChild(overlay);
}

// Enforces the 10-per-click cap by unchecking anything past the 10th
// checked box, with a visible message -- never a silent no-op.
function _bulkInviteCapCheck(changedEl) {
  var checks = Array.prototype.slice.call(document.querySelectorAll('.bulk-invite-check:checked'));
  if (checks.length > 10) {
    changedEl.checked = false;
    var progressEl = document.getElementById('bulk-invite-progress');
    if (progressEl) { progressEl.style.color = 'var(--amber)'; progressEl.textContent = 'Maximum 10 per click -- uncheck one first.'; }
  }
}

async function sendBulkInvites() {
  if (_bulkInviteSending) return;
  var checks = Array.prototype.slice.call(document.querySelectorAll('.bulk-invite-check:checked'));
  if (!checks.length) { alert('Select at least one employee.'); return; }
  if (checks.length > 10) { alert('Select 10 or fewer at a time.'); return; }

  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { alert('Not connected -- refresh and try again.'); return; }

  var btn = document.getElementById('bulk-invite-send-btn');
  var progressEl = document.getElementById('bulk-invite-progress');
  var summaryEl = document.getElementById('bulk-invite-summary');
  _bulkInviteSending = true;
  if (btn) btn.disabled = true;
  if (summaryEl) summaryEl.innerHTML = '';

  var list = (window.PentaEmployees && window.PentaEmployees.listSync) ? window.PentaEmployees.listSync() : [];
  var results = [];
  for (var i = 0; i < checks.length; i++) {
    var empId = checks[i].value;
    var emp = list.find(function (e) { return e.id === empId; });
    var name = emp ? emp.name : empId;
    if (progressEl) progressEl.textContent = 'Sending ' + (i + 1) + ' of ' + checks.length + '…';
    try {
      var res = await sb.functions.invoke('send-invite', { body: { employee_id: empId } });
      if (res.error || !res.data || !res.data.success) {
        var reason = (res.data && res.data.error) || (res.error && res.error.message) || 'unknown error';
        results.push({ name: name, ok: false, reason: reason });
      } else {
        results.push({ name: name, ok: true });
      }
    } catch (e) {
      results.push({ name: name, ok: false, reason: (e && e.message) || 'network error' });
    }
    // Short delay between sends -- paces real SMS sends instead of
    // firing all N simultaneously, and keeps "Sending N of M" readable.
    if (i < checks.length - 1) await new Promise(function (r) { setTimeout(r, 700); });
  }

  if (progressEl) progressEl.textContent = '';
  var sentCount = results.filter(function (r) { return r.ok; }).length;
  var failCount = results.length - sentCount;
  if (summaryEl) {
    summaryEl.innerHTML = '<div style="font-weight:700;margin-bottom:4px">' + sentCount + ' sent, ' + failCount + ' failed</div>'
      + results.map(function (r) {
          return r.ok
            ? '<div style="color:var(--green)">✓ ' + _adminEsc(r.name) + '</div>'
            : '<div style="color:var(--red)">✗ ' + _adminEsc(r.name) + ' — ' + _adminEsc(r.reason) + '</div>';
        }).join('');
  }
  _bulkInviteSending = false;
  if (btn) btn.disabled = false;
  try { if (typeof renderStaffList === 'function') renderStaffList(); } catch (e) {}
}

function matchClientByPhone(phone) {"""

EDITS = [("Add openBulkInviteModal()/sendBulkInvites()/_bulkInviteCapCheck()", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
