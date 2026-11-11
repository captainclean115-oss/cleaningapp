#!/usr/bin/env python3
"""Claire cleanup PART 2: system prompt disambiguation for uncancel_clean.

Without this, the model has no way to know uncancel_clean exists as a
distinct tool from cancel_clean -- the tool list alone (with
uncancel_clean's own description already saying "NEVER call
cancel_clean for these phrases") covers most of it, but an explicit
rule in the main operational-tools guidance, right next to the existing
cancel/schedule/move guidance, makes the disambiguation impossible to
miss.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    +'OPERATIONAL TOOLS\\n'
    +'You also have tools for in-app actions (schedule/move/cancel cleans, change prices, change frequency, record payments, send messages, edit clients, read or edit employee hours, send invoices, add reminders, compute_quote, send_text). Use them whenever they help — don\\'t ask permission. For strategic or analytical questions where no tool is needed, just answer with your reasoning.\\n'"""

NEW = """    +'OPERATIONAL TOOLS\\n'
    +'You also have tools for in-app actions (schedule/move/cancel/uncancel cleans, change prices, change frequency, record payments, send messages, edit clients, read or edit employee hours, send invoices, add reminders, compute_quote, send_text). Use them whenever they help — don\\'t ask permission. For strategic or analytical questions where no tool is needed, just answer with your reasoning.\\n'
    +'"Uncancel", "un-cancel", "restore", and "put it back" (said about a clean) ALWAYS mean uncancel_clean -- NEVER cancel_clean. If cancel_clean\\'s own result says a clean on that date is already cancelled, relay that plainly and ask if ' + _opName + ' wants it restored -- do not call cancel_clean again for the same request.\\n'"""

EDITS = [("Claire cleanup PART 2: system prompt disambiguates uncancel/restore from cancel", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
