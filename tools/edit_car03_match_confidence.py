#!/usr/bin/env python3
"""Claire auth-refresh fix -- STEP 3/4 (part 2): track match confidence
so the offline fallback can tell "exact full-name command" apart from a
risky partial/heuristic match (last-name-only, first-name-only, or the
loose "both tokens present somewhere in the message" case). Needed so
processVoiceCommandLocal can keep acting on confident matches while
refusing to act -- and showing the honest connection-failure message
instead -- on anything less certain, per the task's explicit
"keep the offline parser only for exact full-name commands."
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function parseScheduleCommand(lower, original) {
  // Find client name
  var client = null;
  var clientName = '';
  // Try matching against all clients — find best match
  var bestMatch = null, bestLen = 0;
  PentaClients.forEachClient(function(c) {
    var fn = (c.fn||'').toLowerCase(), ln = (c.ln||'').toLowerCase();
    var full = fn + ' ' + ln;
    if (lower.includes(full) && full.length > bestLen) { bestMatch = c; bestLen = full.length; }
    else if (lower.includes(ln + ' ' + fn) && (ln+' '+fn).length > bestLen) { bestMatch = c; bestLen = (ln+' '+fn).length; }
    else if (lower.includes(fn) && lower.includes(ln) && (fn.length+ln.length) > bestLen) { bestMatch = c; bestLen = fn.length+ln.length; }
    else if (ln.length > 3 && lower.includes(ln) && ln.length > bestLen) { bestMatch = c; bestLen = ln.length; }
  });
  // Claire auth-refresh fix: first-name-only fallback, tried ONLY if
  // nothing above matched -- "Cancel Lisa today" (a bare first name,
  // Tom's exact bug-report phrase) never matched any branch above.
  // Resolved SAFELY: a single match is used; more than one match is
  // genuinely ambiguous and must ask, never guess which "Lisa" was meant.
  var firstNameMatches = [];
  if (!bestMatch) {
    var _pscWords = lower.split(/\\s+/).filter(Boolean);
    PentaClients.forEachClient(function(c) {
      var fn2 = (c.fn||'').toLowerCase();
      if (fn2.length > 2 && _pscWords.indexOf(fn2) !== -1) firstNameMatches.push(c);
    });
    if (firstNameMatches.length === 1) {
      bestMatch = firstNameMatches[0];
    } else if (firstNameMatches.length > 1) {
      return {
        error: 'ambiguous_client',
        candidates: firstNameMatches.slice(0, 5).map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; }),
      };
    }
  }
  if (bestMatch) {
    client = bestMatch;
    clientName = (bestMatch.ln||'')+', '+(bestMatch.fn||'');
  } else {
    return { error: 'Could not find that client. Try saying their full name.' };
  }"""

NEW = """function parseScheduleCommand(lower, original) {
  // Find client name
  var client = null;
  var clientName = '';
  // Try matching against all clients — find best match. matchKind tracks
  // HOW the match was found -- 'full' or 'both_tokens' mean the message
  // genuinely named the client by first AND last name (an "exact full-
  // name command"); 'last_name_only'/'first_name_only' are heuristic
  // partial matches the offline fallback should NOT act on confidently
  // when it's only running because the real API call failed (see
  // processVoiceCommandLocal's use of result.exactFullName below).
  var bestMatch = null, bestLen = 0, matchKind = null;
  PentaClients.forEachClient(function(c) {
    var fn = (c.fn||'').toLowerCase(), ln = (c.ln||'').toLowerCase();
    var full = fn + ' ' + ln;
    if (lower.includes(full) && full.length > bestLen) { bestMatch = c; bestLen = full.length; matchKind = 'full'; }
    else if (lower.includes(ln + ' ' + fn) && (ln+' '+fn).length > bestLen) { bestMatch = c; bestLen = (ln+' '+fn).length; matchKind = 'full'; }
    else if (lower.includes(fn) && lower.includes(ln) && (fn.length+ln.length) > bestLen) { bestMatch = c; bestLen = fn.length+ln.length; matchKind = 'both_tokens'; }
    else if (ln.length > 3 && lower.includes(ln) && ln.length > bestLen) { bestMatch = c; bestLen = ln.length; matchKind = 'last_name_only'; }
  });
  // Claire auth-refresh fix: first-name-only fallback, tried ONLY if
  // nothing above matched -- "Cancel Lisa today" (a bare first name,
  // Tom's exact bug-report phrase) never matched any branch above.
  // Resolved SAFELY: a single match is used; more than one match is
  // genuinely ambiguous and must ask, never guess which "Lisa" was meant.
  var firstNameMatches = [];
  if (!bestMatch) {
    var _pscWords = lower.split(/\\s+/).filter(Boolean);
    PentaClients.forEachClient(function(c) {
      var fn2 = (c.fn||'').toLowerCase();
      if (fn2.length > 2 && _pscWords.indexOf(fn2) !== -1) firstNameMatches.push(c);
    });
    if (firstNameMatches.length === 1) {
      bestMatch = firstNameMatches[0];
      matchKind = 'first_name_only';
    } else if (firstNameMatches.length > 1) {
      return {
        error: 'ambiguous_client',
        candidates: firstNameMatches.slice(0, 5).map(function(c){ return { name: ((c.fn||'')+' '+(c.ln||'')).trim(), city: c.city, id: c.id }; }),
      };
    }
  }
  if (bestMatch) {
    client = bestMatch;
    clientName = (bestMatch.ln||'')+', '+(bestMatch.fn||'');
  } else {
    return { error: 'Could not find that client. Try saying their full name.' };
  }"""

EDITS = [("Claire auth-refresh fix: track match confidence (matchKind) for the offline parser", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
