#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 5 audit groundwork.

Declares which gated tools take a plain CLIENT name vs an EMPLOYEE name
with no specific job to resolve (change_frequency, update_client_notes,
edit_client, change_price, record_payment / employee_day_off,
move_employee, edit_employee_hours). _claireDispatchOrPropose uses
these two sets to resolve the name (ambiguity-safe) before ever
creating a proposal for them, same as cancel/uncancel/move/schedule.

send_text identifies its target by phone number (already specific,
no name to resolve) and add_reminder/batch_edit_employee_hours are left
out deliberately -- see the ship report for why.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// Any tool not listed above fails SAFE: gated + sensitive -- a future new
// tool is never accidentally exempt just because this object wasn't
// updated for it. This is the one place anything reads CLAIRE_TOOL_META.
function _claireToolMeta(name) {"""

NEW = """// Claire proposal-resolve-verify (STEP 5 audit): gated tools that take a
// bare client/employee name and write straight to that record (no
// specific job to look up) -- resolved the same ambiguity-safe way as
// cancel/uncancel/move/schedule_clean, so their proposal summaries also
// show a real resolved name instead of ever falling back to "a
// client"/"an employee".
var CLAIRE_CLIENT_FIELD_TOOLS = {
  change_frequency: 1, update_client_notes: 1, edit_client: 1, change_price: 1, record_payment: 1
};
var CLAIRE_EMPLOYEE_FIELD_TOOLS = {
  employee_day_off: 1, move_employee: 1, edit_employee_hours: 1
};

// Any tool not listed above fails SAFE: gated + sensitive -- a future new
// tool is never accidentally exempt just because this object wasn't
// updated for it. This is the one place anything reads CLAIRE_TOOL_META.
function _claireToolMeta(name) {"""

EDITS = [("Claire proposal-resolve-verify: CLAIRE_CLIENT_FIELD_TOOLS / CLAIRE_EMPLOYEE_FIELD_TOOLS sets", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
