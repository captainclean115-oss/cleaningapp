#!/usr/bin/env python3
"""Pay rate input hardening (PR #200 follow-up). Confirmed live via
read-only review: the Pay Rate ($/hr) input is type="number", which lets
a scroll wheel or an arrow key silently change its value while scrolling
or navigating the page -- the same class of bug an adjacent field
(salary_amount, a different PR) was deliberately built to avoid, but
this one was never fixed. Found TWO live surfaces with the identical
bug, not one: the Staff edit screen (#staff-pay) and a second,
separately-live employee edit modal (#main-emp-pay, wired to its own
"View / Edit" buttons, same underlying PentaEmployees facade). Fixed
once via a single shared _parsePayRateInput() both save paths call,
rather than two copies that could diverge -- same principle every other
fix in this app's history has already learned the hard way.

Rules implemented: text input (never number -- immune to scroll/arrow
drift), accepts $ and commas, rounds to 2 decimals, rejects negative and
non-numeric values with a visible message (never silently clamped or
defaulted to 0), and asks "Is that right?" before saving anything above
$100/hr.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "HTML: #staff-pay -- type=text/inputmode=decimal, not type=number",
        '<div id="staff-pay-rate-field"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Pay Rate ($/hr)</div><input type="number" id="staff-pay" step="0.25" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:\'DM Sans\',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>',
        '<div id="staff-pay-rate-field"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Pay Rate ($/hr)</div><input type="text" inputmode="decimal" id="staff-pay" placeholder="e.g. 22.50" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:\'DM Sans\',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>',
    ),
    (
        "HTML: #main-emp-pay -- type=text/inputmode=decimal, not type=number",
        '<div style="margin-bottom:14px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Hourly Pay Rate ($)</div><input type="number" id="main-emp-pay" step="0.25" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:\'DM Sans\',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>',
        '<div style="margin-bottom:14px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Hourly Pay Rate ($)</div><input type="text" inputmode="decimal" id="main-emp-pay" placeholder="e.g. 22.50" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:\'DM Sans\',sans-serif;font-size:15px;padding:11px 14px;outline:none"></div>',
    ),
    (
        "Add shared _parsePayRateInput() before saveMainEmp (its first caller, textually)",
        "async function saveMainEmp() {",
        """// Pay rate input hardening. Pure function, no DOM access -- callers
// decide what to do with the result. Blank input means "no rate set"
// (null), never 0 -- a real $0/hr wage is never silently implied by an
// empty field. Strips $ and commas before parsing (e.g. "$1,200.50").
function _parsePayRateInput(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return { ok: true, value: null };
  var cleaned = s.replace(/[$,]/g, '').trim();
  if (!/^-?\\d+(\\.\\d+)?$/.test(cleaned)) {
    return { ok: false, message: 'Enter a valid pay rate (numbers only), e.g. 22.50. Nothing was saved.' };
  }
  var n = parseFloat(cleaned);
  if (isNaN(n)) return { ok: false, message: 'Enter a valid pay rate (numbers only). Nothing was saved.' };
  if (n < 0) return { ok: false, message: 'Pay rate cannot be negative. Nothing was saved.' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

async function saveMainEmp() {""",
    ),
    (
        "saveMainEmp: validate before building the patch object",
        """  const status = document.getElementById('main-emp-status').value;
  const emp = {
    name,
    team_id: document.getElementById('main-emp-team').value || null,
    team: (function(){ var _id = document.getElementById('main-emp-team').value; var _t = (window.PentaTeams && _id) ? window.PentaTeams.getById(_id) : null; return _t ? _t.name : ''; })(),
    pin: pin || String(Math.floor(1000 + Math.random() * 9000)),
    payRate: parseFloat(document.getElementById('main-emp-pay').value) || 0,""",
        """  // Pay rate input hardening: validate BEFORE building the patch object
  // -- a rejected value must change nothing, not clamp to 0 or whatever
  // parseFloat() could salvage from garbage input.
  const payRateResult = _parsePayRateInput(document.getElementById('main-emp-pay').value);
  if (!payRateResult.ok) { alert(payRateResult.message); return; }
  if (payRateResult.value != null && payRateResult.value > 100) {
    if (!confirm('$' + payRateResult.value.toFixed(2) + '/hr -- is that right?')) return;
  }

  const status = document.getElementById('main-emp-status').value;
  const emp = {
    name,
    team_id: document.getElementById('main-emp-team').value || null,
    team: (function(){ var _id = document.getElementById('main-emp-team').value; var _t = (window.PentaTeams && _id) ? window.PentaTeams.getById(_id) : null; return _t ? _t.name : ''; })(),
    pin: pin || String(Math.floor(1000 + Math.random() * 9000)),
    payRate: payRateResult.value || 0,""",
    ),
    (
        "saveStaffEmployee: validate before building the patch object",
        """  if (isWorkTypeSwitch) {
    const _wtMsg = newWorkType === 'admin'
      ? ('Switch ' + name + ' to Admin/Office?\\n\\nThis clears their default team and removes any FUTURE daily team assignments (past history is kept). They will no longer appear in Teams or team schedules, and their hours will come only from hours you enter by hand.')
      : ('Switch ' + name + ' back to a Field team?\\n\\nThey will be unassigned -- no team is picked automatically. You\\'ll need to assign them to a team afterward.');
    if (!confirm(_wtMsg)) { return; }
  }""",
        """  if (isWorkTypeSwitch) {
    const _wtMsg = newWorkType === 'admin'
      ? ('Switch ' + name + ' to Admin/Office?\\n\\nThis clears their default team and removes any FUTURE daily team assignments (past history is kept). They will no longer appear in Teams or team schedules, and their hours will come only from hours you enter by hand.')
      : ('Switch ' + name + ' back to a Field team?\\n\\nThey will be unassigned -- no team is picked automatically. You\\'ll need to assign them to a team afterward.');
    if (!confirm(_wtMsg)) { return; }
  }

  // Pay rate input hardening: validate BEFORE building the patch object
  // -- a rejected value must change nothing, not clamp to 0 or whatever
  // parseFloat() could salvage from garbage input.
  const payRateResult = _parsePayRateInput(document.getElementById('staff-pay').value);
  if (!payRateResult.ok) { alert(payRateResult.message); return; }
  if (payRateResult.value != null && payRateResult.value > 100) {
    if (!confirm('$' + payRateResult.value.toFixed(2) + '/hr -- is that right?')) return;
  }""",
    ),
    (
        "saveStaffEmployee: use the validated value instead of a raw parseFloat",
        "    payRate: parseFloat(document.getElementById('staff-pay').value) || 0,",
        "    payRate: payRateResult.value || 0,",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
