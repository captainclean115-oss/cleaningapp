#!/usr/bin/env python3
"""Terminate flow fix (C) -- STEP 0 finding: isTerminatedAsOf excludes
an employee ON the termination date itself, not just after it
(asOfDate >= terminated_at). The modal's date field had no label
explaining this -- add one, stated plainly with a concrete example,
and keep the underlying rule exactly as it is (not changed).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "add plain-language label under the termination date field",
        """    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Termination date *</div>
      <input type="date" id="term-modal-date" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none">
    </div>""",
        """    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Termination date *</div>
      <input type="date" id="term-modal-date" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none">
      <div style="font-size:11px;color:var(--muted);margin-top:5px">This is the date she stops appearing in schedules, hours, and team views -- not her last worked day. Example: pick Oct 15 and she's still shown normally through Oct 14, excluded starting Oct 15.</div>
    </div>""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
