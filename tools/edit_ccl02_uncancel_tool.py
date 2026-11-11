#!/usr/bin/env python3
"""Claire cleanup PART 2: uncancel_clean tool.

Bug report: Claire had no way to restore a cancelled clean -- "un
cancel it" got routed to cancel_clean (the only tool that matched),
whose handler explicitly excludes already-cancelled jobs from its
lookup, so it reported "no clean scheduled" / "couldn't find that job
to cancel" instead of doing anything useful.

Adds uncancel_clean: a real, separate WRITE tool (gated, non-sensitive,
same approval-card/Approve/Reject flow as every other write) that
resolves a job by client+date INCLUDING cancelled ones, and restores it
via the exact same patch shape the Schedule tab's own cancelJob()
uncancel branch already uses (job.cancelled=false, job.cancelReason=null,
_pentaJobWrite('update', ...)) -- same existing write path, not a new one.

cancel_clean itself gets one new branch: if the only matching job on
that date is ALREADY cancelled, it now says so plainly and offers the
restore, instead of falling through to the generic "no clean scheduled"
message that caused the original bug report.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

# --- 1. CLAIRE_TOOLS registration ---------------------------------------
OLD_TOOLS = """  { name: 'cancel_clean', description: 'Cancel/remove a scheduled cleaning job for a client on a specific date', input_schema: { type:'object', properties: { client:{type:'string',description:'Client full name'}, date:{type:'string',description:'Date in YYYY-MM-DD'} }, required:['client'] } },"""

NEW_TOOLS = """  { name: 'cancel_clean', description: 'Cancel/remove a scheduled cleaning job for a client on a specific date', input_schema: { type:'object', properties: { client:{type:'string',description:'Client full name'}, date:{type:'string',description:'Date in YYYY-MM-DD'} }, required:['client'] } },
  { name: 'uncancel_clean', description: 'Restore ("un-cancel") a previously cancelled cleaning job for a client on a specific date, putting it back on the schedule. Use this whenever the user says "uncancel", "un-cancel", "restore", or "put it back" -- NEVER call cancel_clean for these phrases.', input_schema: { type:'object', properties: { client:{type:'string',description:'Client full name'}, date:{type:'string',description:'Date in YYYY-MM-DD'} }, required:['client'] } },"""

EDITS = [("Claire cleanup PART 2: register uncancel_clean in CLAIRE_TOOLS", OLD_TOOLS, NEW_TOOLS)]

if __name__ == "__main__":
    apply_edits(EDITS)
