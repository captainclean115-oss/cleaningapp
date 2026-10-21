#!/usr/bin/env python3
"""Hotfix: pentaShowInviteSendModal was deleted during the server-side
invites rewrite (send-invite Edge Function), but the window-export line
for it was never removed. That line runs at top-level IIFE execution
time on every page load, so the resulting ReferenceError crashed the
rest of that <script> block before `jobs`/`dailyAssignments` could be
declared -- breaking the entire live site (blank page, only the "SORT:"
label visible, no options). Confirmed via headless Chrome before and
after this fix.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

apply_edits([
    (
        "remove orphaned pentaShowInviteSendModal export",
        "  window.pentaSendInvite               = pentaSendInvite;\n"
        "  window.pentaShowInviteSendModal      = pentaShowInviteSendModal;\n"
        "  window.pentaShowSetTempPasswordModal = pentaShowSetTempPasswordModal;\n",
        "  window.pentaSendInvite               = pentaSendInvite;\n"
        "  window.pentaShowSetTempPasswordModal = pentaShowSetTempPasswordModal;\n",
    ),
])
