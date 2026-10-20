#!/usr/bin/env python3
"""Phone + password login feature. Staff screen already shows an invite-
status pill per employee (pentaRenderInvitePillsBatch -> _pillHTML:
Active/Invited/Expired/Revoked/Not invited) and already has a working
"Resend Invite" action (pentaRenderInviteChip already relabels the Send
Invite button once a prior invite exists) -- neither needed new code.
What was missing on #staff-list (renderStaffList): her phone number, and
a visible warning when it's missing or shared with another active
employee (confirmed live: Blanca Payan and Viviana currently normalize
to the same 10-digit number). #staff-subview-list (renderStaffSubview,
a second, separately-maintained live view -- both are rendered together
at every call site in this file) already showed the phone but had no
duplicate/missing warning -- added there too for consistency, in its
own edit script.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function renderStaffList() {
  let list = getStaffList();
  // Sprint 6.9: respect window._staffTeamFilter (set by filter dropdown)
  if (window._staffTeamFilter) list = list.filter(e => e.team_id === window._staffTeamFilter);
  const _teamFor = (e) => {
    const t = (e && e.team_id && window.PentaTeams) ? window.PentaTeams.getById(e.team_id) : null;
    return { color: (t && t.color) || '#6b7280', name: (t && t.name) || e.team || '—' };
  };
  const active = list.filter(e => e.status !== 'terminated');
  const terminated = list.filter(e => e.status === 'terminated');

  const card = (emp, i) => {
    const { color, name: _teamName } = _teamFor(emp);
    if (emp.status === 'terminated') {"""

NEW = """function renderStaffList() {
  let list = getStaffList();
  // Sprint 6.9: respect window._staffTeamFilter (set by filter dropdown)
  if (window._staffTeamFilter) list = list.filter(e => e.team_id === window._staffTeamFilter);
  const _teamFor = (e) => {
    const t = (e && e.team_id && window.PentaTeams) ? window.PentaTeams.getById(e.team_id) : null;
    return { color: (t && t.color) || '#6b7280', name: (t && t.name) || e.team || '—' };
  };
  const active = list.filter(e => e.status !== 'terminated');
  const terminated = list.filter(e => e.status === 'terminated');

  // Phone + password login feature: same normalization rule as the
  // login/invite/reset Edge Functions (strip to digits, drop a leading
  // US "1"). Used here only to flag duplicates/missing numbers on the
  // Staff screen -- never written back to any employee row.
  function _normPhoneForStaffCard(raw) {
    var digits = String(raw || '').replace(/\\D/g, '');
    if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
    return digits.length === 10 ? digits : null;
  }
  var _phoneCounts = {};
  active.forEach(function (e) {
    var n = _normPhoneForStaffCard(e.phone);
    if (n) _phoneCounts[n] = (_phoneCounts[n] || 0) + 1;
  });

  const card = (emp, i) => {
    const { color, name: _teamName } = _teamFor(emp);
    if (emp.status === 'terminated') {"""

EDITS = [("renderStaffList: phone-duplicate detection setup", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
