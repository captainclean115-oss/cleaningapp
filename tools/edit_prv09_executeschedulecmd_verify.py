#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 3, executeScheduleCmd (the
function schedule_clean's Approve path actually writes through).

DIAGNOSIS: claireReply('All set! ...') ran, then `await _pentaJobWrite`
with its return value never checked -- the exact same bug pattern as
cancel_clean, just in a different function. A queued/rejected write
still showed "All set!" with nothing durably saved.

Fix: await the write, verify via PentaJobs.getById, and only then
report success. On failure: roll back the optimistic local insert, show
a visible error in both the voice-cmd-status panel and the chat, and
throw -- so when this runs from _claireApproveProposal's scheduleSpecial
branch, its existing try/catch marks the proposal 'failed' instead of
"Done." (The other call site is a raw onclick="executeScheduleCmd()"
button tap with no awaiting caller; the throw there becomes a swallowed
promise rejection, but the function's own visible status+chat message
above already told the user what happened -- never a silent failure.)
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  jobs.push(_voiceJob);
  saveJobs();

  var dayLabel = new Date(cmd.date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
  logPendingUpdate('Add job: '+cmd.clientName, cmd.timeDisplay+' on '+dayLabel+' · Team '+cmd.team, cmd.viaAI ? 'AI Chat' : (cmd.viaClaire ? 'Claire' : undefined), cmd.client ? cmd.client.id : null);
  renderCal();

  claireReply('All set! '+cmd.clientName+' is booked for '+dayLabel+' at '+cmd.timeDisplay+' with Team '+cmd.team+'.');
  if (typeof _claireAmendLastToolResult === 'function' && cmd.viaClaire) {
    _claireAmendLastToolResult('Tom confirmed. '+cmd.clientName+' booked for '+dayLabel+' at '+cmd.timeDisplay+' with Team '+cmd.team+'.');
  }
  await _pentaJobWrite('insert', { job: _voiceJob });
  window._pendingVoiceCmd = null;
  setTimeout(function(){ status.style.display='none'; }, 3000);
}"""

NEW = """  jobs.push(_voiceJob);
  saveJobs();

  var dayLabel = new Date(cmd.date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});

  // Claire proposal-resolve-verify (bug #2): await the write and verify
  // it actually landed BEFORE reporting success -- the old code called
  // claireReply('All set! ...') first and never checked _pentaJobWrite's
  // return value at all.
  var _schedWrite = await _pentaJobWrite('insert', { job: _voiceJob });
  var _schedConfirmed = _schedWrite && _schedWrite.ok
    && (!(window.PentaJobs && window.PentaJobs.getById) || !!window.PentaJobs.getById(_voiceJob.id));
  window._pendingVoiceCmd = null;
  if (!_schedConfirmed) {
    jobs = jobs.filter(function(j){ return j.id !== _voiceJob.id; });
    saveJobs(); renderCal();
    var _schedFailMsg = cmd.clientName+'\\'s clean for '+dayLabel+' was NOT saved -- the save did not go through. Try again.';
    if (status) {
      status.innerHTML = '<div style="font-size:13px;color:#f87171;line-height:1.4">'+_claireEscapeHtml(_schedFailMsg)+'</div>';
      setTimeout(function(){ status.style.display='none'; }, 4000);
    }
    claireReply(_schedFailMsg);
    throw new Error(_schedFailMsg);
  }

  logPendingUpdate('Add job: '+cmd.clientName, cmd.timeDisplay+' on '+dayLabel+' · Team '+cmd.team, cmd.viaAI ? 'AI Chat' : (cmd.viaClaire ? 'Claire' : undefined), cmd.client ? cmd.client.id : null);
  renderCal();

  claireReply('All set! '+cmd.clientName+' is booked for '+dayLabel+' at '+cmd.timeDisplay+' with Team '+cmd.team+'.');
  if (typeof _claireAmendLastToolResult === 'function' && cmd.viaClaire) {
    _claireAmendLastToolResult('Tom confirmed. '+cmd.clientName+' booked for '+dayLabel+' at '+cmd.timeDisplay+' with Team '+cmd.team+'.');
  }
  setTimeout(function(){ status.style.display='none'; }, 3000);
}"""

EDITS = [("Claire proposal-resolve-verify: executeScheduleCmd verify-after-write", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
