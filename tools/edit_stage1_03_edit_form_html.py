#!/usr/bin/env python3
"""Stage 1 -- PART 3. Add the static "Manager Access" section to the
Staff Edit tab's HTML (fixed ids -- only one edit-form instance exists
in the DOM at a time, reused per employee via staff-edit-idx). Hidden
by default so a brand-new, unsaved employee (openAddStaff, which never
calls openEditStaff) never shows it -- only openEditStaff reveals it.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """      <!-- NOTES -->
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:20px 0 12px">Internal Notes</div>
      <div style="margin-bottom:14px"><textarea id="staff-notes" rows="3" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none;resize:none" placeholder="Any notes about this employee..."></textarea></div>"""

NEW = """      <!-- MANAGER ACCESS (Stage 1) -->
      <div id="staff-edit-mgr-access-wrap" style="margin-bottom:14px;display:none">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:20px 0 12px">Manager Access</div>
        <div id="staff-edit-mgr-access-status" style="font-size:13px;color:var(--muted);margin-bottom:10px">Loading…</div>
        <label id="staff-edit-mgr-access-toggle-wrap" style="display:none;align-items:center;justify-content:space-between;cursor:pointer;padding:8px 0">
          <span style="font-size:13px;font-weight:600">Give manager access</span>
          <input type="checkbox" id="staff-edit-mgr-access-toggle" style="width:20px;height:20px;accent-color:var(--accent)">
        </label>
        <div id="staff-edit-mgr-access-permlink" style="margin-top:6px;font-size:12px;color:var(--muted);display:none">Full access by default — per-permission toggles are coming in the next update.</div>
      </div>

      <!-- NOTES -->
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:20px 0 12px">Internal Notes</div>
      <div style="margin-bottom:14px"><textarea id="staff-notes" rows="3" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none;resize:none" placeholder="Any notes about this employee..."></textarea></div>"""

EDITS = [
    ("Stage 1: add Manager Access static HTML to the Edit tab", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
