#!/usr/bin/env python3
"""Claire approval-gate bypass fix.

BUG: processVoiceCommandLocal (the fallback that runs whenever the
Claude API call fails -- see its two call sites in processVoiceCommand)
parsed "cancel"/"schedule"/"day off"/"reminder" phrases with its OWN
regex logic and wrote directly: job.cancelled = true + _pentaJobWrite
for cancel, dailyAssignments + PentaAssignments.assign for day-off,
manualTasks for reminders, and a same-page Yes/No panel -> executeScheduleCmd
for scheduling -- NONE of it ever touched _claireDispatchOrPropose (the
gate added in PR #219). Reproduced: the real extracted function, given
"cancel the <client> clean for today", calls _pentaJobWrite once and
_claireDispatchOrPropose zero times.

FIX: every one of those four branches now builds the exact same
{name, input} shape the real CLAIRE_TOOLS dispatcher uses and routes it
through _claireDispatchOrPropose -- the SAME gate, SAME proposal card,
SAME Approve/Reject, SAME owner/admin sensitive check. No branch here
performs a write of its own anymore. The old schedule-branch Yes/No
panel is removed entirely (superseded by the proposal card); Approve's
existing scheduleSpecial handling in _claireApproveProposal still drives
executeScheduleCmd() exactly as it already does for the API-driven path.
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
    var dayLabel = new Date(result.date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
    var status = document.getElementById('voice-cmd-status');
    status.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px"><span style="font-size:14px">✦</span><span style="font-size:14px;font-weight:600;color:var(--accent)">Claire</span></div>'
      +'<div style="font-size:13px;color:var(--text);margin-bottom:10px;line-height:1.4">I\\'ll schedule <strong>'+result.clientName+'</strong> for <strong>'+dayLabel+'</strong> at <strong>'+result.timeDisplay+'</strong> with <strong style="color:'+_pentaTeamColor(result.team, 'var(--text)')+'">Team '+result.team+'</strong>. Sound good?</div>'
      +'<div style="display:flex;gap:8px">'
      +'<button onclick="cancelVoiceCmd()" style="flex:1;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--muted);font-family:DM Sans,sans-serif;font-size:14px;cursor:pointer">No</button>'
      +'<button onclick="executeScheduleCmd()" style="flex:1;padding:12px;background:var(--green);border:none;border-radius:10px;color:#000;font-family:DM Sans,sans-serif;font-size:14px;font-weight:700;cursor:pointer">Yes, do it</button>'
      +'</div>';
    window._pendingVoiceCmd = result;
    return;
  }
  if (lower.includes('cancel')) {
    var result2 = parseScheduleCommand(lower, text);
    if (result2.client) {
      var targetDate = result2.date || dateKey(new Date());
      var job = jobs.find(function(j){ return j.clientId === result2.client.id && j.date === targetDate && !j.cancelled; });
      if (job) {
        job.cancelled = true; saveJobs();
        var dayL = new Date(targetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'}); logPendingUpdate('Cancelled: '+job.clientName, dayL, null, result2.client.id); renderCal(); claireReply('Done! Cancelled '+job.clientName+' for '+dayL+'.');
        await _pentaJobWrite('update', { id: job.id, patch: { cancelled: true } });
        return;
      }
    }
    claireReply('Couldn\\'t find that job to cancel.');
    return;
  }
  if (lower.includes('day off') || lower.includes('out sick') || lower.includes('off today')) {
    var empName = text.replace(/day off|off today|out sick|for|put|mark|set/gi,'').trim();
    // Phase 6.5a: facade-first via PentaEmployees.find (substring match), EMPLOYEE_ROSTER fallback.
    var emp = null;
    if (window.PentaEmployees && window.PentaEmployees.find) {
      emp = window.PentaEmployees.find(function(e){ return empName.toLowerCase().includes((e.name||'').toLowerCase()); });
    }
    if (!emp) emp = EMPLOYEE_ROSTER.find(function(e){ return empName.toLowerCase().includes(e.name.toLowerCase()); });
    if (emp) {
      var dk=dateKey(new Date());
      dailyAssignments[dk+'_'+emp.id]='OFF'; saveDailyAssignments();
      // Sprint 10 Phase 3f: dual-write voice dayoff to Supabase.
      try { if (window.PentaAssignments) window.PentaAssignments.assign(dk, 'OFF', emp.id).catch(function(e){ console.warn('[Phase 3f] assign failed:', e); }); } catch(e){}
      logPendingUpdate(emp.name+' → Day Off', new Date().toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'}));
      claireReply('Got it! '+emp.name+' is off today.');
      return;
    }
    claireReply('Couldn\\'t find that employee.'); return;
  }
  // ── REMINDER ──
  if (lower.includes('remind') || lower.includes('remember') || lower.includes('note')) {
    var noteText = text.replace(/remind me to |remind me |remember to |remember |note /gi,'').trim();
    if (noteText) { var now=new Date(); var ts=now.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); manualTasks.unshift({id:Date.now().toString(),text:noteText,time:ts,done:false}); saveManualTasks(); renderTasks(); claireReply('Noted! Added "'+noteText+'" to your reminders.'); return; }
  }
  claireReply((apiErrorReason || 'Sorry, I\\'m having trouble connecting right now.')
    + ' Try: "Schedule [name] [day] [time] [team]" or "Cancel [name] [day]".');
}"""

NEW = """// Claire approval-gate bypass fix (PR follow-up to #219): every branch
// below used to write directly (job.cancelled=true + _pentaJobWrite,
// dailyAssignments + PentaAssignments.assign, manualTasks, or a same-
// page Yes/No panel -> executeScheduleCmd) whenever the Claude API call
// failed and this local fallback ran instead. NONE of that ever touched
// _claireDispatchOrPropose -- the approval gate only gated the API-
// driven path, leaving this offline/degraded path free to execute
// immediately. Every matched branch now builds the SAME {name, input}
// shape the real CLAIRE_TOOLS dispatcher uses and routes it through
// the SAME gate -- same proposal card, same Approve/Reject, same
// owner/admin sensitive check. No branch here writes anything itself.
async function processVoiceCommandLocal(text, apiErrorReason) {
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
  if (lower.includes('cancel')) {
    var result2 = parseScheduleCommand(lower, text);
    if (!result2.client) { claireReply('Couldn\\'t find that job to cancel.'); return; }
    var cancelClientName = ((result2.client && result2.client.fn) || '') + ' ' + ((result2.client && result2.client.ln) || '');
    var cancelTargetDate = result2.date || dateKey(new Date());
    var cancelGateResult = await _claireDispatchOrPropose({ name: 'cancel_clean', input: { client: cancelClientName.trim(), date: cancelTargetDate } }, null);
    claireReply(cancelGateResult);
    _claireFlushProposalCards();
    return;
  }
  if (lower.includes('day off') || lower.includes('out sick') || lower.includes('off today')) {
    var empName = text.replace(/day off|off today|out sick|for|put|mark|set/gi,'').trim();
    // Phase 6.5a: facade-first via PentaEmployees.find (substring match), EMPLOYEE_ROSTER fallback.
    var emp = null;
    if (window.PentaEmployees && window.PentaEmployees.find) {
      emp = window.PentaEmployees.find(function(e){ return empName.toLowerCase().includes((e.name||'').toLowerCase()); });
    }
    if (!emp) emp = EMPLOYEE_ROSTER.find(function(e){ return empName.toLowerCase().includes(e.name.toLowerCase()); });
    if (!emp) { claireReply('Couldn\\'t find that employee.'); return; }
    var dayOffDate = dateKey(new Date());
    var dayOffGateResult = await _claireDispatchOrPropose({ name: 'employee_day_off', input: { employee: emp.name, date: dayOffDate } }, null);
    claireReply(dayOffGateResult);
    _claireFlushProposalCards();
    return;
  }
  // ── REMINDER ──
  if (lower.includes('remind') || lower.includes('remember') || lower.includes('note')) {
    var noteText = text.replace(/remind me to |remind me |remember to |remember |note /gi,'').trim();
    if (noteText) {
      var reminderGateResult = await _claireDispatchOrPropose({ name: 'add_reminder', input: { text: noteText } }, null);
      claireReply(reminderGateResult);
      _claireFlushProposalCards();
      return;
    }
  }
  claireReply((apiErrorReason || 'Sorry, I\\'m having trouble connecting right now.')
    + ' Try: "Schedule [name] [day] [time] [team]" or "Cancel [name] [day]".');
}"""

EDITS = [("Gate bypass fix: route processVoiceCommandLocal's 4 write branches through _claireDispatchOrPropose", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
