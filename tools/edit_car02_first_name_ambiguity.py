#!/usr/bin/env python3
"""Claire auth-refresh fix -- STEP 4 (part 1): first-name-only matching
in the offline parser, resolved SAFELY.

DIAGNOSIS: parseScheduleCommand's client matcher only ever matched a
full "first last" / "last first" substring, BOTH first and last
somewhere in the message, or the LAST NAME ALONE (>3 chars). There was
no branch for FIRST NAME ALONE -- "Cancel Lisa today" (Tom's exact
bug report phrase) never matched anything, bestMatch stayed null, and
the caller got the generic "Could not find that client" error -- which
is what actually produced "Couldn't find that job to cancel."

Fix: a new fallback branch, tried ONLY if nothing above matched, that
checks for a first-name-only match. If exactly one client has that
first name, use it (same as the existing last-name-only branch's
behavior). If MORE THAN ONE client shares it, this is genuinely
ambiguous -- return a new ambiguous_client error (never guess which
one) so the caller can ask "which Lisa?" instead of silently picking
one or claiming nothing was found.
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

EDITS = [("Claire auth-refresh fix: parseScheduleCommand first-name-only match, ambiguous asks instead of guessing", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
