#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- the resolver layer.

DIAGNOSIS (bug #1, empty/generic proposal summaries): _claireDispatchOrPropose
built a proposal's summary and args straight from the model's raw,
unverified toolCall.input, with zero database lookup. _claireProposalSummary
then fell back to placeholder text ("a client"/"an employee") for any
missing/empty field. Tom's "cancel a client clean" card is exactly that
fallback firing.

Fix: resolve the target client/employee/job from the database BEFORE a
proposal is ever created. If resolution fails (no match, or more than
one match), no proposal is created at all -- Claire says plainly what
she couldn't find, and for an ambiguous match, lists the real
candidates instead of guessing one.

These resolvers reuse findClientWithSuggestions/findEmployeeWithSuggestions,
which are already ambiguity-safe (exactly one match wins; more than one
asks which) -- the gap was never in those lookups, only in the fact that
nothing called them before a proposal got created.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// Ranked employee matcher, mirrors findClients() above"""

NEW = """// Claire proposal-resolve-verify (bug #1): resolves a client + an
// EXISTING job BEFORE a proposal is ever created, so the proposal's
// summary and args always carry a real, looked-up database record --
// never a raw, unchecked model-supplied string that can fall back to
// placeholder text like "a client". Used by cancel_clean/uncancel_clean.
// wantCancelled=true looks for an already-cancelled job (uncancel);
// false looks for an active one (cancel).
function _claireResolveClientJob(input, wantCancelled) {
  var lookup = findClientWithSuggestions(input && input.client);
  if (lookup.matches.length === 0) {
    return { ok: false, reason: 'client_not_found', suggestions: lookup.suggestions };
  }
  if (lookup.matches.length > 1) {
    return { ok: false, reason: 'ambiguous_client', candidates: lookup.matches.slice(0, 5) };
  }
  var client = lookup.matches[0];
  var targetDate = (input && input.date) || _claireTodayKey();
  var job = jobs.find(function(j) { return j.clientId === client.id && j.date === targetDate && !!j.cancelled === !!wantCancelled; });
  if (job) return { ok: true, client: client, job: job, dateKey: targetDate };
  var nearest = jobs.filter(function(j) { return j.clientId === client.id && !!j.cancelled === !!wantCancelled; })
    .sort(function(a, b) { return a.date.localeCompare(b.date); })
    .find(function(j) { return j.date >= targetDate; }) || null;
  return { ok: false, reason: 'job_not_found', client: client, dateKey: targetDate, nearest: nearest };
}

// Shared by _claireDispatchOrPropose (propose-time) and
// _executeClaireToolCallInner's move_clean branch (execute-time) so the
// two can never pick a different job for the same request. Mirrors the
// original inline move_clean matching: an exact from_date match, else
// the closest active job within +/-3 days, else the next upcoming clean.
function _claireFindMoveSourceJob(clientId, fromDateInput) {
  function normDate(d) {
    if (!d) return '';
    if (/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return d;
    var p = d.split(/[\\/\\-]/);
    if (p.length === 3 && p[0].length <= 2) return p[2] + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
    return d;
  }
  var todayKey = _claireTodayKey();
  var clientJobs = jobs.filter(function(j) { return j.clientId === clientId && !j.cancelled; })
    .map(function(j) { return Object.assign(j, { _d: normDate(j.date) }); });
  var job = null;
  if (fromDateInput) {
    var wanted = normDate(fromDateInput);
    job = clientJobs.find(function(j) { return j._d === wanted; });
    if (!job) {
      var closest = clientJobs.slice().sort(function(a, b) {
        return Math.abs(new Date(a._d) - new Date(wanted)) - Math.abs(new Date(b._d) - new Date(wanted));
      })[0];
      if (closest && Math.abs(new Date(closest._d) - new Date(wanted)) <= 3 * 86400000) job = closest;
    }
  }
  if (!job) job = clientJobs.filter(function(j) { return j._d >= todayKey; }).sort(function(a, b) { return a._d.localeCompare(b._d); })[0];
  if (!job) {
    var past = clientJobs.sort(function(a, b) { return b._d.localeCompare(a._d); })[0];
    return { job: null, pastLabel: past ? _claireDayLabel(past._d) : null };
  }
  return { job: job, pastLabel: null };
}

// move_clean's full propose-time resolution: client (ambiguity-safe) +
// the specific source job (shared lookup above) + the destination
// fields the model supplied. A move with no destination at all (no
// to_date/time/team) is meaningless, so that's its own failure reason
// rather than silently "moving" a job to itself.
function _claireResolveMoveClean(input) {
  var lookup = findClientWithSuggestions(input && input.client);
  if (lookup.matches.length === 0) return { ok: false, reason: 'client_not_found', suggestions: lookup.suggestions };
  if (lookup.matches.length > 1) return { ok: false, reason: 'ambiguous_client', candidates: lookup.matches.slice(0, 5) };
  var client = lookup.matches[0];
  if (!input || (!input.to_date && !input.time && !input.team)) {
    return { ok: false, reason: 'missing_destination', client: client };
  }
  var found = _claireFindMoveSourceJob(client.id, input && input.from_date);
  if (!found.job) return { ok: false, reason: 'move_source_not_found', client: client, pastLabel: found.pastLabel };
  return {
    ok: true,
    client: client,
    job: found.job,
    toDate: (input.to_date) || found.job.date,
    time: input.time || found.job.time,
    team: input.team ? String(input.team).toUpperCase() : found.job.team
  };
}

// schedule_clean's propose-time resolution: client only (ambiguity-safe
// -- findClient() used by the executor is first-match-wins, which is
// exactly the same risk class cancel_clean had). Date/time/team default
// the same way the executor already does, computed here too so the
// proposal card shows the real values before approval, not just
// whatever subset the model happened to supply.
function _claireResolveScheduleClean(input) {
  var lookup = findClientWithSuggestions(input && input.client);
  if (lookup.matches.length === 0) return { ok: false, reason: 'client_not_found', suggestions: lookup.suggestions };
  if (lookup.matches.length > 1) return { ok: false, reason: 'ambiguous_client', candidates: lookup.matches.slice(0, 5) };
  return {
    ok: true,
    client: lookup.matches[0],
    date: (input && input.date) || _claireTodayKey(),
    time: (input && input.time) || '09:00',
    team: ((input && input.team) || 'B1').toUpperCase()
  };
}

// Client-only resolution (no specific job) for the gated tools that
// write to the CLIENT record itself (price, notes, frequency, profile
// fields, payments) rather than a specific scheduled job. Same
// ambiguity-safe lookup, same "never guess" rule.
function _claireResolveClientOnly(input) {
  var lookup = findClientWithSuggestions(input && input.client);
  if (lookup.matches.length === 0) return { ok: false, reason: 'client_not_found', suggestions: lookup.suggestions };
  if (lookup.matches.length > 1) return { ok: false, reason: 'ambiguous_client', candidates: lookup.matches.slice(0, 5) };
  return { ok: true, client: lookup.matches[0] };
}

// Employee-only resolution, mirrors _claireResolveClientOnly above --
// reuses findEmployeeWithSuggestions (already ambiguity-safe; this
// codebase has 7+ duplicate employee-name groups, see its own comment
// a few lines down).
function _claireResolveEmployeeOnly(input, asOfDate) {
  var lookup = findEmployeeWithSuggestions((input && input.employee) || '', asOfDate || _claireTodayKey());
  if (lookup.matches.length === 0) return { ok: false, reason: 'employee_not_found', suggestions: lookup.suggestions.map(function(e) { return e.name; }) };
  if (lookup.matches.length > 1) return { ok: false, reason: 'ambiguous_employee', candidates: lookup.matches.slice(0, 5) };
  return { ok: true, employee: lookup.matches[0] };
}

// Plain-English, no-proposal message for every resolver failure above.
// Shown INSTEAD of a proposal card -- nothing is ever created when
// resolution fails, per the resolve-before-propose rule.
function _claireResolveFailureMessage(res, actionLabel) {
  if (res.reason === 'client_not_found') {
    var sugg = (res.suggestions || []).map(function(c) { return ((c.fn || '') + ' ' + (c.ln || '')).trim(); }).filter(Boolean).join(', ');
    return 'I couldn\\'t find that client.' + (sugg ? ' Did you mean: ' + sugg + '?' : '');
  }
  if (res.reason === 'ambiguous_client') {
    var names = res.candidates.map(function(c) { return ((c.fn || '') + ' ' + (c.ln || '')).trim(); }).join(', or ');
    return 'I found more than one match -- did you mean ' + names + '? Try their full name.';
  }
  if (res.reason === 'employee_not_found') {
    var esugg = (res.suggestions || []).join(', ');
    return 'I couldn\\'t find that employee.' + (esugg ? ' Did you mean: ' + esugg + '?' : '');
  }
  if (res.reason === 'ambiguous_employee') {
    var enames = res.candidates.map(function(e) { return e.name; }).join(', or ');
    return 'I found more than one match -- did you mean ' + enames + '? Try their full name.';
  }
  if (res.reason === 'job_not_found') {
    var who = _claireShortName(res.client);
    var when = _claireDayLabel(res.dateKey);
    var wantCancelled = actionLabel === 'uncancel';
    var hint = res.nearest ? ' Their next ' + (wantCancelled ? 'cancelled clean I see is' : 'clean is') + ' ' + _claireDayLabel(res.nearest.date) + '.' : '';
    return who + ' has no' + (wantCancelled ? ' cancelled' : '') + ' clean on ' + when + '.' + hint + ' Nothing was ' + (wantCancelled ? 'restored' : 'changed') + '.';
  }
  if (res.reason === 'move_source_not_found') {
    var who2 = _claireShortName(res.client);
    return who2 + ' has no upcoming clean I can find to move.' + (res.pastLabel ? ' Their last one was ' + res.pastLabel + '.' : '') + ' Nothing was moved.';
  }
  if (res.reason === 'missing_destination') {
    return 'I don\\'t have a new date, time, or team to move ' + _claireShortName(res.client) + '\\'s clean to.';
  }
  return 'I couldn\\'t find that. Nothing was changed.';
}

// Builds a proposal's summary from RESOLVED, VERIFIED data (never raw
// model input) for the 4 job-write tools above. Format: "Cancel Lisa
// F.'s clean, Wed Nov 11, 9:00 AM, team B1."
function _claireSummaryTail(j) {
  var bits = [];
  if (j && j.time) bits.push(_claireTimeDisplay(j.time));
  if (j && j.team) bits.push('team ' + String(j.team).toUpperCase());
  return bits.length ? ', ' + bits.join(', ') : '';
}
function _claireResolvedSummary(toolName, r) {
  var who = _claireShortName(r.client);
  if (toolName === 'cancel_clean') {
    return 'Cancel ' + who + '\\'s clean, ' + _claireDayLabel(r.job.date) + _claireSummaryTail(r.job) + '.';
  }
  if (toolName === 'uncancel_clean') {
    return 'Restore ' + who + '\\'s cancelled clean, ' + _claireDayLabel(r.job.date) + _claireSummaryTail(r.job) + '.';
  }
  if (toolName === 'move_clean') {
    return 'Move ' + who + '\\'s clean, ' + _claireDayLabel(r.job.date) + ' \\u2192 ' + _claireDayLabel(r.toDate) + _claireSummaryTail({ time: r.time, team: r.team }) + '.';
  }
  if (toolName === 'schedule_clean') {
    return 'Schedule ' + who + ', ' + _claireDayLabel(r.date) + _claireSummaryTail({ time: r.time, team: r.team }) + '.';
  }
  return null;
}

// Ranked employee matcher, mirrors findClients() above"""

EDITS = [("Claire proposal-resolve-verify: client/job/employee resolvers + resolved-summary builder", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
