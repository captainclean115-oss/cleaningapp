#!/usr/bin/env python3
"""Phone + password login feature. renderStaffSubview() (#staff-subview-
list -- a second live view, rendered alongside renderStaffList at every
call site in this file) already showed the phone number but had no
duplicate/missing warning. Adds the same warning renderStaffList just
got, using its own local copy of the normalize helper (this file already
tolerates this card-building logic being duplicated between the two
views, not introducing a new pattern here).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function renderStaffSubview() {
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
    const langLabel = {en:'EN',es:'ES',pt:'PT',cv:'KR'}[emp.lang||'en']||'EN';
    if (emp.status === 'terminated') {"""

NEW = """function renderStaffSubview() {
  let list = getStaffList();
  // Sprint 6.9: respect window._staffTeamFilter (set by filter dropdown)
  if (window._staffTeamFilter) list = list.filter(e => e.team_id === window._staffTeamFilter);
  const _teamFor = (e) => {
    const t = (e && e.team_id && window.PentaTeams) ? window.PentaTeams.getById(e.team_id) : null;
    return { color: (t && t.color) || '#6b7280', name: (t && t.name) || e.team || '—' };
  };
  const active = list.filter(e => e.status !== 'terminated');
  const terminated = list.filter(e => e.status === 'terminated');

  // Phone + password login feature: same normalization/duplicate check
  // as renderStaffList's own copy -- see that function's comment.
  function _normPhoneForSubviewCard(raw) {
    var digits = String(raw || '').replace(/\\D/g, '');
    if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
    return digits.length === 10 ? digits : null;
  }
  var _subviewPhoneCounts = {};
  active.forEach(function (e) {
    var n = _normPhoneForSubviewCard(e.phone);
    if (n) _subviewPhoneCounts[n] = (_subviewPhoneCounts[n] || 0) + 1;
  });

  const card = (emp, i) => {
    const { color, name: _teamName } = _teamFor(emp);
    const langLabel = {en:'EN',es:'ES',pt:'PT',cv:'KR'}[emp.lang||'en']||'EN';
    if (emp.status === 'terminated') {"""

EDITS = [("renderStaffSubview: phone-duplicate detection setup", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
