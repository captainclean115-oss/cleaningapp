#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 3, schedule_clean.

_executeClaireToolCallInner's schedule_clean branch: prefer the client
already resolved at propose time (ambiguity-safe), and the date/time/
team already resolved there too (so the proposal card's summary and the
eventual write can never disagree). findClient() (first-match-wins) is
kept only as a defensive fallback.

schedule_clean doesn't write here -- it defers to executeScheduleCmd()
(edit_prv09, same sprint), which has the SAME "report success before
checking the write" bug this whole task is about: it called
claireReply('All set! ...') and only then awaited _pentaJobWrite,
never checking what it returned.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  if (name === 'schedule_clean') {
    var client = findClient(input.client);
    if (!client) { _claireLastToolResult = 'Client not found: "'+input.client+'".'; claireReply(message || 'I couldn\\'t find that client. Can you give me their full name?'); return; }
    var result = {
      client: client,
      clientName: (client.ln||'')+', '+(client.fn||''),
      date: input.date || dateKey(new Date()),
      time: input.time || '09:00',
      timeDisplay: '',
      team: (input.team||'B1').toUpperCase(),
      viaClaire: true
    };"""

NEW = """  if (name === 'schedule_clean') {
    var client = null;
    if (input._resolvedClientId) client = (PentaClients && PentaClients.getClient) ? PentaClients.getClient(input._resolvedClientId) : null;
    if (!client) {
      // Defensive fallback -- should only be reachable if this ever ran
      // without going through _claireDispatchOrPropose's resolution.
      var _schedLookup = findClientWithSuggestions(input.client);
      if (_schedLookup.matches.length === 0) throw new Error('that client could not be found.');
      if (_schedLookup.matches.length > 1) throw new Error('more than one client matches "' + input.client + '" -- ask which one.');
      client = _schedLookup.matches[0];
    }
    var result = {
      client: client,
      clientName: (client.ln||'')+', '+(client.fn||''),
      date: input._resolvedDate || input.date || _claireTodayKey(),
      time: input._resolvedTime || input.time || '09:00',
      timeDisplay: '',
      team: (input._resolvedTeam || input.team || 'B1').toUpperCase(),
      viaClaire: true
    };"""

EDITS = [("Claire proposal-resolve-verify: schedule_clean resolved-client fast path", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
