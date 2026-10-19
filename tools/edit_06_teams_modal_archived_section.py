#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- make the Teams modal's
"Archived / Former Employees" section actually work. It has never
rendered a single row before this fix: its filter read
termData[e.id]?.status from getRosterTermData() (localStorage key
'roster_term_data'), which nothing in this file ever writes to
(confirmed: zero call sites of saveRosterTermData outside its own
definition) -- AND it filtered an already bare-getUnifiedRoster()'d
list, which excludes every terminated employee before this filter even
ran. Two independent reasons the section was permanently empty.

Rebuilt to read the facade directly (the one thing here that genuinely
needs "who's excluded as of dateStr", the opposite of every other
roster read in this function) and show real termination_reason/
terminated_at/eligible_for_rehire off the real employee row, plus a
Rehire button (rehireEmployeeWithConfirm already existed for exactly
this -- its own comment says "called from the Archived-card 'Rehire'
button" -- it just never had a caller because this section never
rendered anything). No Edit/Move/Assign buttons, per spec ("read-only,
no assign buttons") -- Rehire is a status action, not a team-assignment
one, and is the one action this list exists to offer.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  // Archived / terminated section
  const terminated = getUnifiedRoster().filter(e => (termData[e.id]?.status) === 'terminated');
  if (terminated.length > 0) {
    html += `<div style="margin-bottom:16px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px">📁 Archived — Former Employees (${terminated.length})</div>
      ${terminated.map(emp => {
        const td = termData[emp.id] || {};
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin-bottom:6px;background:var(--surface2);border-radius:10px;border-left:3px solid var(--red);opacity:0.7">
          <div>
            <div style="font-size:14px;color:var(--text)">${emp.name}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">
              ${td.reason || 'No reason'} · ${td.termDate || ''}
              ${td.rehire ? ' · <span style="color:var(--green)">✓ Rehire OK</span>' : ' · <span style="color:var(--red)">✗ No rehire</span>'}
            </div>
          </div>
          <button onclick="openRosterEmpEdit('${emp.id}')"
            style="background:var(--surface);border:1px solid var(--border);color:var(--accent);font-family:'DM Sans',sans-serif;font-size:12px;padding:4px 10px;border-radius:12px;cursor:pointer">Edit</button>
        </div>`;
      }).join('')}
    </div>`;
  }"""

NEW = """  // Archived / terminated section (migration 104). Reads the facade
  // DIRECTLY rather than through getUnifiedRoster() -- this section's
  // job is the exact opposite of every other roster read in this
  // function: it wants the employees who ARE excluded as of dateStr,
  // not the ones who aren't. See module comment above (edit_06) for
  // why this never rendered a row before this fix.
  const _tmFacadeAll = (window.PentaEmployees && window.PentaEmployees.listSync) ? window.PentaEmployees.listSync() : [];
  const terminated = _tmFacadeAll.filter(fe => fe.status === 'terminated' && (!fe.terminated_at || dateStr >= fe.terminated_at));
  if (terminated.length > 0) {
    const _tmStaffList = getStaffList();
    html += `<div style="margin-bottom:16px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:8px">📁 Archived — Former Employees as of ${_adminEsc(dateStr)} (${terminated.length})</div>
      ${terminated.map(fe => {
        const rosterId = fe.legacy_roster_id || fe.id;
        const idx = _tmStaffList.findIndex(x => x.id === rosterId || x.id === fe.id);
        const rehireBtn = idx >= 0
          ? `<button onclick="rehireEmployeeWithConfirm(${idx},'staff')"
              style="background:rgba(52,211,153,0.18);border:1px solid rgba(52,211,153,0.45);color:#34d399;font-family:'DM Sans',sans-serif;font-size:12px;padding:4px 10px;border-radius:12px;cursor:pointer">Rehire</button>`
          : '';
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin-bottom:6px;background:var(--surface2);border-radius:10px;border-left:3px solid var(--red);opacity:0.7">
          <div>
            <div style="font-size:14px;color:var(--text)">${_adminEsc(fe.name)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">
              ${_adminEsc(_terminationReasonLabel(fe.termination_reason))} · ${_adminEsc(_pentaFormatDateOnly(fe.terminated_at))}
              ${fe.eligible_for_rehire === false ? ' · <span style="color:var(--red)">✗ No rehire</span>' : ' · <span style="color:var(--green)">✓ Rehire OK</span>'}
            </div>
          </div>
          ${rehireBtn}
        </div>`;
      }).join('')}
    </div>`;
  }"""

EDITS = [("rebuild Archived / Former Employees section", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
