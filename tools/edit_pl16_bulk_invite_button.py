#!/usr/bin/env python3
"""Server-side invites feature. "Bulk invite" entry point on the Staff
sheet header, alongside the existing Teams/View as team/+ Add buttons.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """        <button onclick="viewAsTeam()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 12px;border-radius:20px;cursor:pointer">👁️ View as team</button>
        <button onclick="openAddStaff()" style="background:var(--accent);border:none;color:#fff;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 14px;border-radius:20px;cursor:pointer">+ Add</button>"""

NEW = """        <button onclick="viewAsTeam()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 12px;border-radius:20px;cursor:pointer">👁️ View as team</button>
        <button onclick="openBulkInviteModal()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 12px;border-radius:20px;cursor:pointer">✉️ Bulk invite</button>
        <button onclick="openAddStaff()" style="background:var(--accent);border:none;color:#fff;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 14px;border-radius:20px;cursor:pointer">+ Add</button>"""

EDITS = [("Staff sheet header: Bulk invite button", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
