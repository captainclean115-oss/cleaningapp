#!/usr/bin/env python3
"""Claire cleanup PART 2: dispatcher changes.

1. cancel_clean's "no clean scheduled" fallback now checks for an
   ALREADY-CANCELLED job on that date first, and says so plainly with
   the exact wording from the bug report ("that clean is already
   cancelled -- want me to restore it?") instead of the generic "no
   clean scheduled" message that caused the original confusion.

2. New uncancel_clean branch: resolves the job by client+date
   INCLUDING cancelled ones (the opposite filter from cancel_clean),
   and restores it via the EXACT same write shape the Schedule tab's
   own cancelJob() uncancel branch already uses -- not a new write
   path, the same one.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    var client2 = _cancelLookup.matches[0];
    var targetDate = input.date || dateKey(new Date());
    var job = jobs.find(function(j){ return j.clientId === client2.id && j.date === targetDate && !j.cancelled; });
    if (job) {
      job.cancelled = true; saveJobs();
      var dayL = new Date(targetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
      logPendingUpdate('Cancelled: '+job.clientName, dayL, null, client2.id); renderCal();
      _claireLastToolResult = 'Cancelled '+client2.fn+' '+client2.ln+'\\'s '+dayL+' clean. Done.';
      claireReply(message || 'Done! Cancelled '+client2.fn+' '+client2.ln+' for '+dayL+'.');
      await _pentaJobWrite('update', { id: job.id, patch: { cancelled: true } });
    } else {
      var nextJob = jobs.filter(function(j){ return j.clientId === client2.id && !j.cancelled && j.date > targetDate; }).sort(function(a,b){ return a.date.localeCompare(b.date); })[0];
      var dateL = new Date(targetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
      var hint = nextJob ? ' Their next clean is '+new Date(nextJob.date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})+'.' : '';
      _claireLastToolResult = client2.fn+' '+client2.ln+' has no clean scheduled on '+dateL+'.'+hint+' Nothing was cancelled.';
      claireReply(client2.fn+' '+client2.ln+' doesn\\'t have a clean on '+dateL+'.'+hint);
    }

  // ── MOVE CLEAN ──
  } else if (name === 'move_clean') {"""

NEW = """    var client2 = _cancelLookup.matches[0];
    var targetDate = input.date || dateKey(new Date());
    var job = jobs.find(function(j){ return j.clientId === client2.id && j.date === targetDate && !j.cancelled; });
    if (job) {
      job.cancelled = true; saveJobs();
      var dayL = new Date(targetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
      logPendingUpdate('Cancelled: '+job.clientName, dayL, null, client2.id); renderCal();
      _claireLastToolResult = 'Cancelled '+client2.fn+' '+client2.ln+'\\'s '+dayL+' clean. Done.';
      claireReply(message || 'Done! Cancelled '+client2.fn+' '+client2.ln+' for '+dayL+'.');
      await _pentaJobWrite('update', { id: job.id, patch: { cancelled: true } });
    } else {
      // Claire cleanup PART 2: the ONLY matching job on this date might
      // already be cancelled -- that used to fall straight through to
      // "no clean scheduled," which is what produced the original bug
      // report ("un cancel it" -> "couldn't find that job to cancel").
      // Check for it explicitly and say so, with the restore offer.
      var alreadyCancelled = jobs.find(function(j){ return j.clientId === client2.id && j.date === targetDate && j.cancelled; });
      if (alreadyCancelled) {
        var dateAC = new Date(targetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
        _claireLastToolResult = client2.fn+' '+client2.ln+'\\'s clean on '+dateAC+' is already cancelled. Nothing changed.';
        claireReply('That clean is already cancelled — want me to restore it?');
        return;
      }
      var nextJob = jobs.filter(function(j){ return j.clientId === client2.id && !j.cancelled && j.date > targetDate; }).sort(function(a,b){ return a.date.localeCompare(b.date); })[0];
      var dateL = new Date(targetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
      var hint = nextJob ? ' Their next clean is '+new Date(nextJob.date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})+'.' : '';
      _claireLastToolResult = client2.fn+' '+client2.ln+' has no clean scheduled on '+dateL+'.'+hint+' Nothing was cancelled.';
      claireReply(client2.fn+' '+client2.ln+' doesn\\'t have a clean on '+dateL+'.'+hint);
    }

  // ── UNCANCEL CLEAN ──
  // Claire cleanup PART 2. Mirror of cancel_clean's lookup, but the job
  // filter is INVERTED (must already be cancelled) and the write is the
  // exact same patch shape the Schedule tab's own cancelJob() uncancel
  // branch already uses -- the same existing uncancel path, not a new one.
  } else if (name === 'uncancel_clean') {
    var _uncancelLookup = findClientWithSuggestions(input.client);
    if (_uncancelLookup.matches.length === 0) {
      _claireLastToolResult = JSON.stringify({
        error: 'client_not_found',
        query: input.client,
        suggestions: _uncancelLookup.suggestions.map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; })
      });
      return;
    }
    if (_uncancelLookup.matches.length > 1) {
      _claireLastToolResult = JSON.stringify({
        error: 'ambiguous_client',
        query: input.client,
        candidates: _uncancelLookup.matches.slice(0, 5).map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; })
      });
      return;
    }
    var client4 = _uncancelLookup.matches[0];
    var uncancelTargetDate = input.date || dateKey(new Date());
    var cancelledJob = jobs.find(function(j){ return j.clientId === client4.id && j.date === uncancelTargetDate && j.cancelled; });
    if (cancelledJob) {
      cancelledJob.cancelled = false; cancelledJob.cancelReason = null; saveJobs();
      var dayU = new Date(uncancelTargetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
      logPendingUpdate('Uncancelled: '+cancelledJob.clientName, dayU, null, client4.id); renderCal();
      _claireLastToolResult = 'Restored '+client4.fn+' '+client4.ln+'\\'s '+dayU+' clean. Done.';
      claireReply(message || 'Done! Restored '+client4.fn+' '+client4.ln+'\\'s clean for '+dayU+'.');
      await _pentaJobWrite('update', { id: cancelledJob.id, patch: { cancelled: false, cancelReason: null } });
    } else {
      var activeJob = jobs.find(function(j){ return j.clientId === client4.id && j.date === uncancelTargetDate && !j.cancelled; });
      var dateU = new Date(uncancelTargetDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
      if (activeJob) {
        _claireLastToolResult = client4.fn+' '+client4.ln+'\\'s clean on '+dateU+' isn\\'t cancelled. Nothing changed.';
        claireReply(client4.fn+' '+client4.ln+'\\'s clean on '+dateU+' isn\\'t cancelled -- nothing to restore.');
      } else {
        _claireLastToolResult = 'No cancelled clean found for '+client4.fn+' '+client4.ln+' on '+dateU+'. Nothing was restored.';
        claireReply('I couldn\\'t find a cancelled clean for '+client4.fn+' '+client4.ln+' on '+dateU+'.');
      }
    }

  // ── MOVE CLEAN ──
  } else if (name === 'move_clean') {"""

EDITS = [("Claire cleanup PART 2: already-cancelled message + uncancel_clean dispatcher branch", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
