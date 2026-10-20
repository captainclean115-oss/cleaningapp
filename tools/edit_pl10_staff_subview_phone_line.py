#!/usr/bin/env python3
"""Phone + password login feature. Upgrades renderStaffSubview()'s
existing plain phone line to the same missing/shared warning styling
renderStaffList's card just got.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """        ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
        </div>
        ${emp.phone ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">📱 ${emp.phone}</div>` : ''}
      </div>
      <button onclick="openStaffProfile(${i})" style="background:var(--accent);border:none;color:#fff;font-family:'DM Sans',sans-serif;font-size:12px;padding:6px 12px;border-radius:20px;cursor:pointer">View / Edit</button>
    </div>`;
  };

  let html = active.map(emp => card(emp, list.indexOf(emp))).join('');"""

NEW = """        ${emp.status==='inactive'?'<span style="color:var(--red)">Inactive</span>':''}
        </div>
        ${(function () {
          var n = _normPhoneForSubviewCard(emp.phone);
          var shared = n && _subviewPhoneCounts[n] > 1;
          if (!emp.phone) return '<div style="font-size:12px;color:var(--red);margin-top:4px">⚠ No phone on file</div>';
          if (shared) return '<div style="font-size:12px;color:var(--red);margin-top:4px" title="Shared with another active employee">⚠ 📱 ' + emp.phone + ' (shared)</div>';
          return '<div style="font-size:12px;color:var(--muted);margin-top:4px">📱 ' + emp.phone + '</div>';
        })()}
      </div>
      <button onclick="openStaffProfile(${i})" style="background:var(--accent);border:none;color:#fff;font-family:'DM Sans',sans-serif;font-size:12px;padding:6px 12px;border-radius:20px;cursor:pointer">View / Edit</button>
    </div>`;
  };

  let html = active.map(emp => card(emp, list.indexOf(emp))).join('');"""

EDITS = [("renderStaffSubview card: phone missing/shared warning", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
