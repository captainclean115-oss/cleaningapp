#!/usr/bin/env python3
"""Claire cleanup PART 2: offline fallback (processVoiceCommandLocal)
gets its own uncancel/restore branch, checked BEFORE the "cancel"
branch -- "uncancel" contains the substring "cancel", so without this
ordering an uncancel phrase would always match the cancel branch first
and never reach here. Routes through the SAME gate as every other
offline-fallback write (PR #220's bypass fix) -- never a direct write.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  if (lower.includes('cancel')) {
    var result2 = parseScheduleCommand(lower, text);
    if (!result2.client) { claireReply('Couldn\\'t find that job to cancel.'); return; }
    var cancelClientName = ((result2.client && result2.client.fn) || '') + ' ' + ((result2.client && result2.client.ln) || '');
    var cancelTargetDate = result2.date || dateKey(new Date());
    var cancelGateResult = await _claireDispatchOrPropose({ name: 'cancel_clean', input: { client: cancelClientName.trim(), date: cancelTargetDate } }, null);
    claireReply(cancelGateResult);
    _claireFlushProposalCards();
    return;
  }"""

NEW = """  // Claire cleanup PART 2: checked BEFORE the plain "cancel" branch below --
  // "uncancel" contains the substring "cancel", so this MUST come first or
  // an uncancel phrase would always match cancel_clean instead.
  if (lower.includes('uncancel') || lower.includes('un-cancel') || lower.includes('un cancel') || lower.includes('restore') || lower.includes('put it back') || lower.includes('put that back')) {
    var resultU = parseScheduleCommand(lower, text);
    if (!resultU.client) { claireReply('Couldn\\'t find that job to restore.'); return; }
    var uncancelClientName = ((resultU.client && resultU.client.fn) || '') + ' ' + ((resultU.client && resultU.client.ln) || '');
    var uncancelTargetDate = resultU.date || dateKey(new Date());
    var uncancelGateResult = await _claireDispatchOrPropose({ name: 'uncancel_clean', input: { client: uncancelClientName.trim(), date: uncancelTargetDate } }, null);
    claireReply(uncancelGateResult);
    _claireFlushProposalCards();
    return;
  }
  if (lower.includes('cancel')) {
    var result2 = parseScheduleCommand(lower, text);
    if (!result2.client) { claireReply('Couldn\\'t find that job to cancel.'); return; }
    var cancelClientName = ((result2.client && result2.client.fn) || '') + ' ' + ((result2.client && result2.client.ln) || '');
    var cancelTargetDate = result2.date || dateKey(new Date());
    var cancelGateResult = await _claireDispatchOrPropose({ name: 'cancel_clean', input: { client: cancelClientName.trim(), date: cancelTargetDate } }, null);
    claireReply(cancelGateResult);
    _claireFlushProposalCards();
    return;
  }"""

EDITS = [("Claire cleanup PART 2: offline fallback uncancel/restore branch, gated, checked before cancel", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
