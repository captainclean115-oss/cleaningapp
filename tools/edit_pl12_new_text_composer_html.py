#!/usr/bin/env python3
"""Manager-text-any-number feature. "New text" button next to the inbox
search bar -- #rc-inbox-section is part of #messages-view, which is
already CSS-hidden whenever body has the in-portal class (confirmed:
`body.in-portal #messages-view { display: none !important }`), so this
is never reachable by an employee session without any new gating code.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  <div id="rc-inbox-section" style="display:none">
    <div style="padding:10px 16px 6px;position:sticky;top:0;background:var(--bg);z-index:10">
      <div style="display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:8px 14px">
        <span style="font-size:16px;color:var(--muted)">🔍</span>
        <input id="inbox-search" type="text" placeholder="Search clients or numbers..." oninput="filterInbox(this.value)"
          style="flex:1;background:none;border:none;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;outline:none">
        <button id="inbox-search-clear" onclick="document.getElementById('inbox-search').value='';filterInbox('')" style="display:none;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0">×</button>
      </div>
    </div>
    <div id="inbox-list"></div>
  </div>"""

NEW = """  <div id="rc-inbox-section" style="display:none">
    <div style="padding:10px 16px 6px;position:sticky;top:0;background:var(--bg);z-index:10">
      <div style="display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:8px 14px">
        <span style="font-size:16px;color:var(--muted)">🔍</span>
        <input id="inbox-search" type="text" placeholder="Search clients or numbers..." oninput="filterInbox(this.value)"
          style="flex:1;background:none;border:none;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;outline:none">
        <button id="inbox-search-clear" onclick="document.getElementById('inbox-search').value='';filterInbox('')" style="display:none;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0">×</button>
      </div>
      <button onclick="openNewTextComposer()" style="width:100%;margin-top:8px;background:var(--accent);border:none;color:#fff;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;padding:9px;border-radius:10px;cursor:pointer">✎ New text</button>
    </div>
    <div id="inbox-list"></div>
  </div>"""

EDITS = [("Messages screen: New text button next to inbox search", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
