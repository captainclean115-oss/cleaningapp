#!/usr/bin/env python3
"""Phone + password login feature. Shows the sign-in phone number on
each active employee's card, with a visible warning badge when it's
missing (blocks the invite button already, per pentaSendInvite's own
check) or shared with another active employee (a real, confirmed-live
ambiguity that should be fixed by hand before relying on phone login).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    const langLabel = {en:'EN',es:'ES',pt:'PT',cv:'KR'}[emp.lang||'en']||'EN';
    // v9.5.1: ⭐ for team_leader, nothing for team_member.
    const _leaderStar = (emp.position === 'team_leader')
      ? ' <span title="Team Leader" style="color:#F59E0B;font-size:13px;margin-left:2px">★</span>'
      : '';
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:8px;display:flex;align-items:center;gap:12px;${emp.status==='inactive'?'opacity:0.5':''}">
      <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600">${emp.name}${_leaderStar}</div>
        <div style="font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px">
          <span style="color:${color};font-weight:600">${_teamName}</span>
          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? '<span style="color:#fbbf24;font-weight:700">Salaried</span>' : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
          <span data-invite-pill data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}"></span>
        </div>
      </div>
      <button onclick="openStaffProfile(${i})" style="background:var(--accent);border:none;color:#fff;font-family:'DM Sans',sans-serif;font-size:12px;padding:6px 12px;border-radius:20px;cursor:pointer">View / Edit</button>
    </div>`;
  };"""

NEW = """    const langLabel = {en:'EN',es:'ES',pt:'PT',cv:'KR'}[emp.lang||'en']||'EN';
    // v9.5.1: ⭐ for team_leader, nothing for team_member.
    const _leaderStar = (emp.position === 'team_leader')
      ? ' <span title="Team Leader" style="color:#F59E0B;font-size:13px;margin-left:2px">★</span>'
      : '';
    // Phone + password login feature: phone display + duplicate/missing warning.
    const _normPhone = _normPhoneForStaffCard(emp.phone);
    const _phoneShared = _normPhone && _phoneCounts[_normPhone] > 1;
    const _phoneHtml = !emp.phone
      ? '<span style="color:var(--red)">⚠ No phone on file</span>'
      : _phoneShared
        ? `<span style="color:var(--red)" title="Shared with another active employee">⚠ ${emp.phone} (shared)</span>`
        : `<span>${emp.phone}</span>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:8px;display:flex;align-items:center;gap:12px;${emp.status==='inactive'?'opacity:0.5':''}">
      <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600">${emp.name}${_leaderStar}</div>
        <div style="font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;margin-top:2px">
          <span style="color:${color};font-weight:600">${_teamName}</span>
          ${(typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) ? '<span style="color:#fbbf24;font-weight:700">Salaried</span>' : (emp.payRate ? `<span style="color:var(--green)">$${parseFloat(emp.payRate).toFixed(2)}/hr</span>` : '')}
          <span>${langLabel}</span>
          ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
          ${_phoneHtml}
          <span data-invite-pill data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}"></span>
        </div>
      </div>
      <button onclick="openStaffProfile(${i})" style="background:var(--accent);border:none;color:#fff;font-family:'DM Sans',sans-serif;font-size:12px;padding:6px 12px;border-radius:20px;cursor:pointer">View / Edit</button>
    </div>`;
  };"""

EDITS = [("renderStaffList card: phone number + duplicate/missing warning", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
