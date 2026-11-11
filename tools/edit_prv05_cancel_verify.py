#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 3, cancel_clean.

DIAGNOSIS (bug #2, false "Done"): the old code reported success
(_claireLastToolResult + claireReply) and ONLY THEN awaited
_pentaJobWrite, without ever checking what it returned. _pentaJobWrite
never throws for an ordinary failure -- it queues the write for retry
and returns {ok:false, queued:true} -- so a dead connection or RLS
rejection at approve time still showed "Done" with nothing actually
saved. Separately, the "job not found"/"already cancelled" branches
just returned a descriptive string with no throw, so
_claireApproveProposal's throw-only failure detection marked those
'executed' too.

Fix: prefer the job/client already resolved by _claireDispatchOrPropose
(input._resolvedJobId/_resolvedClientId) instead of re-searching by
name -- propose and approve can never disagree about which job. Await
the write FIRST, then re-read the row via PentaJobs.getById (which
_pentaJobWrite's own success path already refreshes with the server's
confirmed state) and only report success if that re-read actually
shows cancelled:true. Every other outcome -- write queued/rejected,
re-read doesn't confirm, job already cancelled, no job found at all --
throws instead of returning, so _claireApproveProposal's existing
catch marks the proposal 'failed' and shows a concrete, honest error
instead of "Done."
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  // ── CANCEL ──
  } else if (name === 'cancel_clean') {
    var _cancelLookup = findClientWithSuggestions(input.client);
    if (_cancelLookup.matches.length === 0) {
      _claireLastToolResult = JSON.stringify({
        error: 'client_not_found',
        query: input.client,
        suggestions: _cancelLookup.suggestions.map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; })
      });
      return;
    }
    if (_cancelLookup.matches.length > 1) {
      _claireLastToolResult = JSON.stringify({
        error: 'ambiguous_client',
        query: input.client,
        candidates: _cancelLookup.matches.slice(0, 5).map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; })
      });
      return;
    }
    var client2 = _cancelLookup.matches[0];
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
    }"""

NEW = """  // ── CANCEL ──
  } else if (name === 'cancel_clean') {
    var client2 = null, job = null;
    if (input._resolvedClientId && input._resolvedJobId) {
      client2 = (PentaClients && PentaClients.getClient) ? PentaClients.getClient(input._resolvedClientId) : null;
      job = jobs.find(function(j){ return j.id === input._resolvedJobId; });
    }
    if (!client2 || !job) {
      // Defensive fallback -- should only be reachable if this ever ran
      // without going through _claireDispatchOrPropose's resolution.
      var _cancelLookup = findClientWithSuggestions(input.client);
      if (_cancelLookup.matches.length === 0) {
        throw new Error('that client could not be found.');
      }
      if (_cancelLookup.matches.length > 1) {
        throw new Error('more than one client matches "' + input.client + '" -- ask which one.');
      }
      client2 = _cancelLookup.matches[0];
      var targetDate = input.date || _claireTodayKey();
      job = jobs.find(function(j){ return j.clientId === client2.id && j.date === targetDate && !j.cancelled; });
    }
    if (!job) {
      throw new Error((client2 ? client2.fn + ' ' + client2.ln : 'that client') + ' has no clean on that date -- it may have already been changed.');
    }
    if (job.cancelled) {
      // Already in the target state (a race between propose and
      // approve, or a stale resolved id) -- NOT the outcome the human
      // asked for, so this is a failure to report honestly, never "Done."
      throw new Error(client2.fn+' '+client2.ln+'\\'s clean on '+_claireDayLabel(job.date)+' was already cancelled.');
    }
    var dayL = _claireDayLabel(job.date);
    var wasCancelled = job.cancelled;
    job.cancelled = true; saveJobs();
    var _cancelWrite = await _pentaJobWrite('update', { id: job.id, patch: { cancelled: true } });
    var _cancelConfirmed = _cancelWrite && _cancelWrite.ok
      && (!(window.PentaJobs && window.PentaJobs.getById) || (function(){ var f = window.PentaJobs.getById(job.id); return !!f && f.cancelled === true; })());
    if (!_cancelConfirmed) {
      job.cancelled = wasCancelled; saveJobs();
      throw new Error(client2.fn+' '+client2.ln+'\\'s '+dayL+' clean was not cancelled -- the save did not go through.');
    }
    logPendingUpdate('Cancelled: '+job.clientName, dayL, null, client2.id); renderCal();
    _claireLastToolResult = 'Cancelled '+client2.fn+' '+client2.ln+'\\'s '+dayL+' clean. Done.';
    claireReply(message || 'Done! Cancelled '+client2.fn+' '+client2.ln+' for '+dayL+'.');"""

EDITS = [("Claire proposal-resolve-verify: cancel_clean resolved-id execute + verify-after-write", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
