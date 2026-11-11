#!/usr/bin/env python3
"""Claire auth-refresh fix -- STEP 3 + STEP 4 (part 3): honest fallback
messaging. processVoiceCommandLocal only ever runs because the real
API call already failed (apiErrorReason is always set in production --
both its call sites pass one). The old code let the crude parser
confidently claim "Couldn't find that job to cancel" whenever its own
heuristic matching came up short or ambiguous -- which is exactly what
happened to Tom ("Cancel Lisa today"): the real problem was the dead
API connection, but the message blamed a nonexistent job instead.

New shared gate (_claireOfflineClientResult): when apiErrorReason is
set, only an EXACT, UNAMBIGUOUS full-name match is acted on. An
ambiguous match asks which client was meant (never guesses); anything
else -- no match, or only a risky partial match (last-name-only,
first-name-only) -- surfaces the real, honest reason instead of a
false "that job doesn't exist" claim.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function processVoiceCommandLocal(text, apiErrorReason) {
  var lower = text.toLowerCase();

  if (lower.includes('schedule') || lower.includes('book') || lower.includes('add a clean') || lower.includes('add clean')) {
    var result = parseScheduleCommand(lower, text);
    if (result.error) { claireReply(result.error); return; }
    var scheduleClientName = ((result.client && result.client.fn) || '') + ' ' + ((result.client && result.client.ln) || '');
    var scheduleGateResult = await _claireDispatchOrPropose({ name: 'schedule_clean', input: { client: scheduleClientName.trim(), date: result.date, time: result.time, team: result.team } }, null);
    claireReply(scheduleGateResult);
    _claireFlushProposalCards();
    return;
  }
  // Claire cleanup PART 2: checked BEFORE the plain "cancel" branch below --
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

NEW = """// Claire auth-refresh fix: this function ONLY ever runs because the
// real API call already failed (both its call sites always pass
// apiErrorReason) -- so it must never let a crude local guess claim a
// job/client doesn't exist when the real problem is the dead
// connection. Only an EXACT, UNAMBIGUOUS full-name match (both first
// AND last name genuinely present in the message) is confident enough
// to act on in that degraded mode. An ambiguous match asks which
// client was meant, never guesses. Anything else -- no match, or only
// a risky partial match (last-name-only, first-name-only) -- surfaces
// the real, honest reason instead.
function _claireOfflineClientResult(lower, text, apiErrorReason) {
  var result = parseScheduleCommand(lower, text);
  if (result.error === 'ambiguous_client') {
    var names = result.candidates.map(function (c) { return c.name; }).join(', or ');
    return { ok: false, message: 'I found more than one match — did you mean ' + names + '? Try their full name.' };
  }
  if (!result.client || !result.exactFullName) {
    if (apiErrorReason) return { ok: false, message: apiErrorReason };
    return { ok: false, message: result.error || 'Could not find that client. Try saying their full name.' };
  }
  return { ok: true, result: result };
}

async function processVoiceCommandLocal(text, apiErrorReason) {
  var lower = text.toLowerCase();

  if (lower.includes('schedule') || lower.includes('book') || lower.includes('add a clean') || lower.includes('add clean')) {
    var scheduleCheck = _claireOfflineClientResult(lower, text, apiErrorReason);
    if (!scheduleCheck.ok) { claireReply(scheduleCheck.message); return; }
    var result = scheduleCheck.result;
    var scheduleClientName = ((result.client && result.client.fn) || '') + ' ' + ((result.client && result.client.ln) || '');
    var scheduleGateResult = await _claireDispatchOrPropose({ name: 'schedule_clean', input: { client: scheduleClientName.trim(), date: result.date, time: result.time, team: result.team } }, null);
    claireReply(scheduleGateResult);
    _claireFlushProposalCards();
    return;
  }
  // Claire cleanup PART 2: checked BEFORE the plain "cancel" branch below --
  // "uncancel" contains the substring "cancel", so this MUST come first or
  // an uncancel phrase would always match cancel_clean instead.
  if (lower.includes('uncancel') || lower.includes('un-cancel') || lower.includes('un cancel') || lower.includes('restore') || lower.includes('put it back') || lower.includes('put that back')) {
    var uncancelCheck = _claireOfflineClientResult(lower, text, apiErrorReason);
    if (!uncancelCheck.ok) { claireReply(uncancelCheck.message); return; }
    var resultU = uncancelCheck.result;
    var uncancelClientName = ((resultU.client && resultU.client.fn) || '') + ' ' + ((resultU.client && resultU.client.ln) || '');
    var uncancelTargetDate = resultU.date || dateKey(new Date());
    var uncancelGateResult = await _claireDispatchOrPropose({ name: 'uncancel_clean', input: { client: uncancelClientName.trim(), date: uncancelTargetDate } }, null);
    claireReply(uncancelGateResult);
    _claireFlushProposalCards();
    return;
  }
  if (lower.includes('cancel')) {
    var cancelCheck = _claireOfflineClientResult(lower, text, apiErrorReason);
    if (!cancelCheck.ok) { claireReply(cancelCheck.message); return; }
    var result2 = cancelCheck.result;
    var cancelClientName = ((result2.client && result2.client.fn) || '') + ' ' + ((result2.client && result2.client.ln) || '');
    var cancelTargetDate = result2.date || dateKey(new Date());
    var cancelGateResult = await _claireDispatchOrPropose({ name: 'cancel_clean', input: { client: cancelClientName.trim(), date: cancelTargetDate } }, null);
    claireReply(cancelGateResult);
    _claireFlushProposalCards();
    return;
  }"""

EDITS = [("Claire auth-refresh fix: honest offline-fallback messaging via a shared confidence gate", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
