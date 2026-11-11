#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 3, uncancel_clean. Exact
mirror of the cancel_clean fix (edit_prv05): resolved-id fast path,
await-then-verify-then-report, throw (never silently return) on any
non-matching outcome so Approve can never show "Done" without the
restore actually having saved.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  } else if (name === 'uncancel_clean') {
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
    }"""

NEW = """  } else if (name === 'uncancel_clean') {
    var client4 = null, cancelledJob = null;
    if (input._resolvedClientId && input._resolvedJobId) {
      client4 = (PentaClients && PentaClients.getClient) ? PentaClients.getClient(input._resolvedClientId) : null;
      cancelledJob = jobs.find(function(j){ return j.id === input._resolvedJobId; });
    }
    if (!client4 || !cancelledJob) {
      var _uncancelLookup = findClientWithSuggestions(input.client);
      if (_uncancelLookup.matches.length === 0) {
        throw new Error('that client could not be found.');
      }
      if (_uncancelLookup.matches.length > 1) {
        throw new Error('more than one client matches "' + input.client + '" -- ask which one.');
      }
      client4 = _uncancelLookup.matches[0];
      var uncancelTargetDate = input.date || _claireTodayKey();
      cancelledJob = jobs.find(function(j){ return j.clientId === client4.id && j.date === uncancelTargetDate && j.cancelled; });
    }
    if (!cancelledJob) {
      throw new Error((client4 ? client4.fn + ' ' + client4.ln : 'that client') + ' has no cancelled clean on that date to restore.');
    }
    if (!cancelledJob.cancelled) {
      throw new Error(client4.fn+' '+client4.ln+'\\'s clean on '+_claireDayLabel(cancelledJob.date)+' isn\\'t cancelled -- there is nothing to restore.');
    }
    var dayU = _claireDayLabel(cancelledJob.date);
    cancelledJob.cancelled = false; cancelledJob.cancelReason = null; saveJobs();
    var _uncancelWrite = await _pentaJobWrite('update', { id: cancelledJob.id, patch: { cancelled: false, cancelReason: null } });
    var _uncancelConfirmed = _uncancelWrite && _uncancelWrite.ok
      && (!(window.PentaJobs && window.PentaJobs.getById) || (function(){ var f = window.PentaJobs.getById(cancelledJob.id); return !!f && f.cancelled === false; })());
    if (!_uncancelConfirmed) {
      cancelledJob.cancelled = true; saveJobs();
      throw new Error(client4.fn+' '+client4.ln+'\\'s '+dayU+' clean was not restored -- the save did not go through.');
    }
    logPendingUpdate('Uncancelled: '+cancelledJob.clientName, dayU, null, client4.id); renderCal();
    _claireLastToolResult = 'Restored '+client4.fn+' '+client4.ln+'\\'s '+dayU+' clean. Done.';
    claireReply(message || 'Done! Restored '+client4.fn+' '+client4.ln+'\\'s clean for '+dayU+'.');"""

EDITS = [("Claire proposal-resolve-verify: uncancel_clean resolved-id execute + verify-after-write", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
