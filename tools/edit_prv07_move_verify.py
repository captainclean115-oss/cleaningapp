#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 3, move_clean.

Same shape as cancel/uncancel (edit_prv05/06): prefer the job already
resolved at propose time (input._resolvedClientId/_resolvedJobId,
_resolvedToDate/_resolvedTime/_resolvedTeam) so propose and approve can
never disagree about which job moves where. The old fuzzy from_date
matching (exact -> closest within 3 days -> next upcoming) is now
_claireFindMoveSourceJob, shared with the resolver, and kept here only
as the defensive fallback for a call that somehow skipped resolution.

Await the write, then re-read via PentaJobs.getById and only report
success if the fields that were actually supposed to change (date/
time/team) actually show the new values. Anything else throws so
Approve marks the proposal 'failed' with a concrete message instead of
"Done."
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  } else if (name === 'move_clean') {
    var _moveLookup = findClientWithSuggestions(input.client);
    if (_moveLookup.matches.length === 0) {
      _claireLastToolResult = JSON.stringify({
        error: 'client_not_found',
        query: input.client,
        suggestions: _moveLookup.suggestions.map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; })
      });
      return;
    }
    if (_moveLookup.matches.length > 1) {
      _claireLastToolResult = JSON.stringify({
        error: 'ambiguous_client',
        query: input.client,
        candidates: _moveLookup.matches.slice(0, 5).map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; })
      });
      return;
    }
    var client3 = _moveLookup.matches[0];
    // Normalize a job's date to YYYY-MM-DD regardless of stored format
    function _normDate(d){
      if (!d) return '';
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return d;
      var p = d.split(/[\\/\\-]/);
      if (p.length === 3 && p[0].length <= 2) return p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0');
      return d;
    }
    var todayKey = dateKey(new Date());
    var clientJobs = jobs.filter(function(j){ return j.clientId === client3.id && !j.cancelled; })
      .map(function(j){ return Object.assign(j, { _d: _normDate(j.date) }); });
    var job2 = null;
    if (input.from_date) {
      var wanted = _normDate(input.from_date);
      job2 = clientJobs.find(function(j){ return j._d === wanted; });
      // If no exact match, try the closest job within ±3 days
      if (!job2) {
        var closest = clientJobs.slice().sort(function(a,b){
          return Math.abs(new Date(a._d) - new Date(wanted)) - Math.abs(new Date(b._d) - new Date(wanted));
        })[0];
        if (closest && Math.abs(new Date(closest._d) - new Date(wanted)) <= 3*86400000) job2 = closest;
      }
    }
    if (!job2) {
      // Fall back to the next upcoming clean for this client
      job2 = clientJobs.filter(function(j){ return j._d >= todayKey; }).sort(function(a,b){ return a._d.localeCompare(b._d); })[0];
    }
    if (!job2) {
      var past = clientJobs.sort(function(a,b){ return b._d.localeCompare(a._d); })[0];
      _claireLastToolResult = 'No upcoming clean found for '+client3.fn+' '+client3.ln+'.'+(past?' Their last clean was '+new Date(past._d+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})+'.':'')+' Nothing was moved.';
      claireReply((message ? message + ' ' : '') + 'I couldn\\'t find an upcoming clean for '+client3.fn+' '+client3.ln+'.'+(past?' The last one I see is '+new Date(past._d+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})+'.':''));
      return;
    }
    // Confirm WHICH clean we're moving (by the found date) in the reply
    var foundDayL = new Date(job2._d+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
    if (input.to_date) job2.date = input.to_date;
    if (input.time) { job2.time = input.time; job2.flexible = false; }
    if (input.team) job2.team = input.team.toUpperCase();
    saveJobs();
    // Sprint 10 Phase 3c: dual-write Claire move_clean to Supabase. Only
    // patch fields that actually changed. recalcTeamTimes (called below)
    // dual-writes the cascade for downstream jobs on the destination team,
    // and is now the single render point for this move (it always renders
    // exactly once) -- an extra renderCal() here used to double-render.
    var _movePatch = {};
    if (input.to_date) _movePatch.date = job2.date;
    if (input.time)    { _movePatch.time = job2.time; _movePatch.flexible = job2.flexible; }
    if (input.team)    _movePatch.team = job2.team;
    if (Object.keys(_movePatch).length) await _pentaJobWrite('update', { id: job2.id, patch: _movePatch });
    var newDayL = new Date(_normDate(job2.date)+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
    logPendingUpdate('Moved: '+job2.clientName, foundDayL + ' → ' + newDayL, null, client3.id);
    recalcTeamTimes(job2.team, job2.date, job2.id);
    var moveMsg = 'Moved '+client3.fn+' '+client3.ln+'\\'s '+foundDayL+' clean to '+newDayL+(input.time ? ' at '+input.time : '')+(input.team ? ' with Team '+input.team.toUpperCase() : '')+'.';
    _claireLastToolResult = moveMsg+' Done.';
    claireReply(message || moveMsg);"""

NEW = """  } else if (name === 'move_clean') {
    // Normalize a job's date to YYYY-MM-DD regardless of stored format
    function _normDate(d){
      if (!d) return '';
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return d;
      var p = d.split(/[\\/\\-]/);
      if (p.length === 3 && p[0].length <= 2) return p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0');
      return d;
    }
    var client3 = null, job2 = null;
    if (input._resolvedClientId && input._resolvedJobId) {
      client3 = (PentaClients && PentaClients.getClient) ? PentaClients.getClient(input._resolvedClientId) : null;
      job2 = jobs.find(function(j){ return j.id === input._resolvedJobId; });
    }
    if (!client3 || !job2) {
      // Defensive fallback -- should only be reachable if this ever ran
      // without going through _claireDispatchOrPropose's resolution.
      var _moveLookup = findClientWithSuggestions(input.client);
      if (_moveLookup.matches.length === 0) throw new Error('that client could not be found.');
      if (_moveLookup.matches.length > 1) throw new Error('more than one client matches "' + input.client + '" -- ask which one.');
      client3 = _moveLookup.matches[0];
      var _found = _claireFindMoveSourceJob(client3.id, input.from_date);
      job2 = _found.job;
      if (!job2) {
        throw new Error('no upcoming clean could be found for ' + client3.fn + ' ' + client3.ln + (_found.pastLabel ? ' (last one was ' + _found.pastLabel + ')' : '') + '.');
      }
    }
    // Confirm WHICH clean we're moving (by the found date) in the reply
    var foundDayL = _claireDayLabel(_normDate(job2.date));
    var toDate = input._resolvedToDate || input.to_date;
    var toTime = input._resolvedTime || input.time;
    var toTeam = input._resolvedTeam || (input.team ? String(input.team).toUpperCase() : null);
    var _movePatch = {};
    if (toDate) { job2.date = toDate; _movePatch.date = toDate; }
    if (toTime) { job2.time = toTime; job2.flexible = false; _movePatch.time = toTime; _movePatch.flexible = false; }
    if (toTeam) { job2.team = toTeam; _movePatch.team = toTeam; }
    if (!Object.keys(_movePatch).length) {
      throw new Error('there was no new date, time, or team to move ' + client3.fn + ' ' + client3.ln + '\\'s clean to.');
    }
    saveJobs();
    // Sprint 10 Phase 3c: dual-write Claire move_clean to Supabase.
    var _moveWrite = await _pentaJobWrite('update', { id: job2.id, patch: _movePatch });
    var _moveConfirmed = _moveWrite && _moveWrite.ok
      && (!(window.PentaJobs && window.PentaJobs.getById) || (function(){
            var f = window.PentaJobs.getById(job2.id);
            if (!f) return false;
            if (_movePatch.date && f.date !== _movePatch.date) return false;
            if (_movePatch.time && f.time !== _movePatch.time) return false;
            if (_movePatch.team && f.team !== _movePatch.team) return false;
            return true;
          })());
    if (!_moveConfirmed) {
      throw new Error(client3.fn+' '+client3.ln+'\\'s '+foundDayL+' clean was not moved -- the save did not go through.');
    }
    var newDayL = _claireDayLabel(_normDate(job2.date));
    // recalcTeamTimes dual-writes the cascade for downstream jobs on the
    // destination team, and is the single render point for this move
    // (it always renders exactly once) -- an extra renderCal() here
    // used to double-render.
    recalcTeamTimes(job2.team, job2.date, job2.id);
    logPendingUpdate('Moved: '+job2.clientName, foundDayL + ' → ' + newDayL, null, client3.id);
    var moveMsg = 'Moved '+client3.fn+' '+client3.ln+'\\'s '+foundDayL+' clean to '+newDayL+(toTime ? ' at '+toTime : '')+(toTeam ? ' with Team '+toTeam : '')+'.';
    _claireLastToolResult = moveMsg+' Done.';
    claireReply(message || moveMsg);"""

EDITS = [("Claire proposal-resolve-verify: move_clean resolved-id execute + verify-after-write", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
