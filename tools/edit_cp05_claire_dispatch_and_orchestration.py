#!/usr/bin/env python3
"""Claire portal-links feature, step 5: the shared orchestration
function (_claireSendPortalLinks, used by BOTH new tools so the
preview/confirm/cap/skip/sequential-send/audit logic exists exactly
once) and the two dispatch branches in _executeClaireToolCallInner.
Also wires send_portal_invite/send_password_reset_link into
_claireWriteSummary/_clairePreviewSummary/_claireErrorSummary, the same
round-cap-fallback pattern batch_edit_employee_hours already uses."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

ORCH_ANCHOR_OLD = """function _claireTerminatedExplanation(query, asOfDate) {
  try {
    var hist = findEmployeeWithSuggestions(query, _ROSTER_ALL_HISTORY_ASOF);
    if (hist.matches.length !== 1) return null;
    var fe = hist.matches[0];
    if (fe.status !== 'terminated' || !fe.terminated_at) return null;
    if (asOfDate < fe.terminated_at) return null; // not yet terminated as of asOfDate -- not the explanation
    return { name: fe.name, terminated_at: fe.terminated_at };
  } catch (e) { return null; }
}

// Tools that return information to Claire rather than perform an action."""

ORCH_ANCHOR_NEW = """function _claireTerminatedExplanation(query, asOfDate) {
  try {
    var hist = findEmployeeWithSuggestions(query, _ROSTER_ALL_HISTORY_ASOF);
    if (hist.matches.length !== 1) return null;
    var fe = hist.matches[0];
    if (fe.status !== 'terminated' || !fe.terminated_at) return null;
    if (asOfDate < fe.terminated_at) return null; // not yet terminated as of asOfDate -- not the explanation
    return { name: fe.name, terminated_at: fe.terminated_at };
  } catch (e) { return null; }
}

// Claire portal-links feature -- shared by send_portal_invite and
// send_password_reset_link (kind: 'invite' | 'reset') so the preview/
// confirm/cap/skip/sequential-send/audit logic exists exactly once,
// not once per tool. Name resolution reuses findEmployeeWithSuggestions
// + _claireTerminatedExplanation -- the EXACT same disambiguation and
// date-aware-roster logic the hours tools already use, not a second
// copy. The actual per-employee send reuses pentaSendInvite (invite)
// or pentaSendPasswordReset (reset) -- the SAME functions the Staff
// screen's own buttons call, so the 60s resend guard, the double-click
// guard, and the duplicate-active-phone check are all inherited for
// free, never reimplemented here.
async function _claireSendPortalLinks(input, kind) {
  var sendFn = (kind === 'invite') ? pentaSendInvite : pentaSendPasswordReset;
  var names = Array.isArray(input.employees) ? input.employees.filter(Boolean) : [];
  var wantAll = input.all === true;
  if (!wantAll && !names.length) {
    return { error: { kind: 'no_employees_specified' } };
  }

  var resolved = [];
  var skipped = [];

  function considerFull(full, queriedName) {
    if (!full) { skipped.push({ name: queriedName, reason: 'could not load this employee\\'s record.' }); return; }
    if (full.status === 'terminated') { skipped.push({ name: full.name || queriedName, reason: 'terminated.' }); return; }
    if (!full.phone) { skipped.push({ name: full.name || queriedName, reason: 'no phone on file.' }); return; }
    var dupReason = _findDuplicateActivePhoneOwnerReason(full);
    if (dupReason) { skipped.push({ name: full.name || queriedName, reason: dupReason }); return; }
    if (kind === 'invite' && full.auth_user_id) { skipped.push({ name: full.name || queriedName, reason: 'already has a login.' }); return; }
    if (kind === 'reset' && !full.auth_user_id) { skipped.push({ name: full.name || queriedName, reason: 'no login yet -- send an invite instead.' }); return; }
    resolved.push({ rosterId: full.legacy_roster_id || full.id, uuid: full.id, name: full.name || queriedName });
  }

  if (wantAll) {
    var roster = getUnifiedRoster();
    for (var i = 0; i < roster.length; i++) {
      var full = (window.PentaEmployees && window.PentaEmployees.getById) ? window.PentaEmployees.getById(roster[i].uuid) : null;
      considerFull(full, roster[i].name);
    }
  } else {
    for (var j = 0; j < names.length; j++) {
      var lookup = findEmployeeWithSuggestions(names[j]);
      if (lookup.matches.length > 1) {
        return { error: { kind: 'ambiguous_employee', query: names[j],
          candidates: lookup.matches.slice(0, 5).map(function (e) { return { name: e.name, id: e.id }; }) } };
      }
      if (lookup.matches.length === 0) {
        var termExp = _claireTerminatedExplanation(names[j], dateKey(new Date()));
        if (termExp) { skipped.push({ name: termExp.name, reason: 'terminated on ' + _pentaFormatDateOnly(termExp.terminated_at) + '.' }); continue; }
        return { error: { kind: 'employee_not_found', query: names[j],
          suggestions: lookup.suggestions.map(function (e) { return e.name; }) } };
      }
      var r = lookup.matches[0];
      var full2 = (window.PentaEmployees && window.PentaEmployees.getById) ? window.PentaEmployees.getById(r.uuid) : null;
      considerFull(full2, r.name);
    }
  }

  var isSingle = !wantAll && names.length === 1;

  if (!resolved.length) {
    // Nothing eligible at all -- nothing to confirm, just report why.
    return { success: true, kind: kind, sent: [], failed: [], skipped: skipped, remaining: 0 };
  }

  if (!isSingle && !input.confirmed) {
    // Preview only -- NO sends. Capped to the 10 a confirmed call would
    // actually process first, so the preview never promises more than
    // one call will do.
    var previewSends = resolved.slice(0, 10);
    var overflow = resolved.length - previewSends.length;
    return {
      preview: true, kind: kind,
      recipients: previewSends.map(function (r) { return r.name; }),
      skipped: skipped,
      remaining_after_this_batch: overflow > 0 ? overflow : 0
    };
  }

  // Sending now -- a single employee (confirmation not required), or a
  // batch Tom already confirmed. Cap at 10 per call regardless.
  var toSend = resolved.slice(0, 10);
  var overflowCount = resolved.length - toSend.length;
  var sent = [];
  var failed = [];
  for (var k = 0; k < toSend.length; k++) {
    var t = toSend[k];
    var r2;
    try {
      r2 = await sendFn(t.rosterId);
    } catch (e) {
      r2 = { ok: false, reason: (e && e.message) || String(e) };
    }
    var auditResult = (r2 && r2.ok) ? 'sent' : 'failed';
    // Best-effort, non-fatal -- never logs the link/token, only the
    // outcome. action_type 'manual_note' is the established catch-all
    // for "something happened" rows that don't fit a lifecycle verb
    // (see _auditSupplement's own calling-convention comment).
    try {
      var _auditPayload = { source: 'claire_portal_link', type: kind, result: auditResult };
      if (r2 && !r2.ok && r2.reason) _auditPayload.reason = r2.reason;
      await _auditSupplement('manual_note', 'employee', t.uuid, _auditPayload);
    } catch (auditErr) { console.warn('[Claire] send_portal_link audit failed (non-fatal)', auditErr); }
    if (r2 && r2.ok) {
      sent.push({ name: t.name, maskedPhone: r2.maskedPhone || null });
    } else {
      failed.push({ name: t.name, reason: (r2 && r2.reason) || 'unknown error' });
    }
    // Short delay between sends -- paces real SMS sends instead of
    // firing all N simultaneously, same idea as sendBulkInvites.
    if (k < toSend.length - 1) { await new Promise(function (res) { setTimeout(res, 700); }); }
  }

  return {
    success: true, kind: kind,
    sent: sent, failed: failed, skipped: skipped,
    remaining: overflowCount > 0 ? overflowCount : 0
  };
}

// Tools that return information to Claire rather than perform an action."""

DISPATCH_ANCHOR_OLD = """    _claireLastToolResult = JSON.stringify({ success: true, count: beApplied.length, updated: beApplied.map(function(r){ return { employee: r.employee.name, date: r.date }; }) });
    claireReply(message || ('Updated hours for ' + beApplied.length + ': ' + beDayList + '. Done.'));

  // ── LOCATE TEAM ──  (query tool — no claireReply)"""

DISPATCH_ANCHOR_NEW = """    _claireLastToolResult = JSON.stringify({ success: true, count: beApplied.length, updated: beApplied.map(function(r){ return { employee: r.employee.name, date: r.date }; }) });
    claireReply(message || ('Updated hours for ' + beApplied.length + ': ' + beDayList + '. Done.'));

  // ── PORTAL INVITES / PASSWORD RESETS ──  (Claire portal-links feature)
  } else if (name === 'send_portal_invite' || name === 'send_password_reset_link') {
    var _plKind = (name === 'send_portal_invite') ? 'invite' : 'reset';
    // Claire's tools run only in a manager/owner session; the
    // send-invite Edge Function itself ALSO verifies the role
    // server-side (not trusted from here) -- this is the client-side
    // refusal for the "an employee session somehow reaches Claire"
    // case, defense in depth, not the only gate.
    var _plRole = (typeof getCurrentAppRole === 'function') ? getCurrentAppRole() : null;
    if (!_plRole || ['owner', 'admin', 'manager', 'dispatcher'].indexOf(_plRole) === -1) {
      _claireLastToolResult = JSON.stringify({ error: 'not_authorized' });
      claireReply('Only a manager or owner can send portal links.');
      return;
    }

    var _plResult;
    try {
      _plResult = await _claireSendPortalLinks(input, _plKind);
    } catch (e) {
      console.error('[Claire] ' + name + ' threw', e);
      _claireLastToolResult = 'Tool ' + name + ' threw: ' + ((e && e.message) || String(e));
      return;
    }

    if (_plResult.error) {
      _claireLastToolResult = JSON.stringify(_plResult.error);
      return;
    }

    if (_plResult.preview) {
      // No sends happened. Claude's own next turn presents this list
      // and waits for confirmation -- same pattern as
      // batch_edit_employee_hours's own preview branch.
      _claireLastToolResult = JSON.stringify(_plResult);
      return;
    }

    _claireLastToolResult = JSON.stringify(_plResult);
    var _plNoun = (_plKind === 'invite') ? 'invite' : 'reset link';
    if (_plResult.sent.length === 1 && _plResult.failed.length === 0 && !_plResult.skipped.length) {
      var _plOne = _plResult.sent[0];
      claireReply(message || ('Sent the ' + _plNoun + ' to ' + _plOne.name + ' at ' + (_plOne.maskedPhone || 'her phone') + '.'));
    } else if (!_plResult.sent.length && !_plResult.failed.length && _plResult.skipped.length) {
      claireReply(message || ('Didn\\'t send any ' + _plNoun + 's -- ' + _plResult.skipped.map(function (s) { return s.name + ' (' + s.reason + ')'; }).join(', ') + '.'));
    } else {
      var _plSummary = 'Sent ' + _plResult.sent.length + ', failed ' + _plResult.failed.length
        + (_plResult.skipped.length ? (', skipped ' + _plResult.skipped.length) : '') + '.';
      claireReply(message || _plSummary);
    }

  // ── LOCATE TEAM ──  (query tool — no claireReply)"""

SUMMARY_WRITE_OLD = """function _claireWriteSummary(toolName, resStr) {
  if (toolName === 'batch_edit_employee_hours') {"""

SUMMARY_WRITE_NEW = """function _claireWriteSummary(toolName, resStr) {
  if (toolName === 'send_portal_invite' || toolName === 'send_password_reset_link') {
    try {
      var plParsed = JSON.parse(resStr);
      if (plParsed && plParsed.success === true && Array.isArray(plParsed.sent)) {
        var plNoun = (toolName === 'send_portal_invite') ? 'invite(s)' : 'reset link(s)';
        if (!plParsed.sent.length) return 'Sent no ' + plNoun + ' -- everyone was skipped.';
        return 'Sent ' + plNoun + ' to ' + plParsed.sent.map(function (s) { return s.name; }).join(', ') + '.';
      }
    } catch (e) {}
    return null;
  }
  if (toolName === 'batch_edit_employee_hours') {"""

SUMMARY_PREVIEW_OLD = """function _clairePreviewSummary(toolName, resStr) {
  if (toolName !== 'batch_edit_employee_hours') return null;
  try {
    var parsed = JSON.parse(resStr);
    if (parsed && parsed.preview === true && Array.isArray(parsed.changes) && parsed.changes.length) {
      return 'About to set ' + parsed.changes.length + ':\\n'
        + parsed.changes.map(function(c){ return '- ' + c.employee + ' ' + c.date + ': ' + c.current + ' -> ' + c.proposed; }).join('\\n')
        + '\\nConfirm all?';
    }
  } catch(e) {}
  return null;
}"""

SUMMARY_PREVIEW_NEW = """function _clairePreviewSummary(toolName, resStr) {
  if (toolName === 'send_portal_invite' || toolName === 'send_password_reset_link') {
    try {
      var plParsed = JSON.parse(resStr);
      if (plParsed && plParsed.preview === true && Array.isArray(plParsed.recipients)) {
        var plLines = 'About to text ' + plParsed.recipients.length + ': ' + plParsed.recipients.join(', ') + '.';
        if (plParsed.skipped && plParsed.skipped.length) {
          plLines += '\\nSkipped: ' + plParsed.skipped.map(function (s) { return s.name + ' (' + s.reason + ')'; }).join(', ') + '.';
        }
        if (plParsed.remaining_after_this_batch) {
          plLines += '\\n' + plParsed.remaining_after_this_batch + ' more eligible after this batch.';
        }
        return plLines + '\\nConfirm all?';
      }
    } catch (e) {}
    return null;
  }
  if (toolName !== 'batch_edit_employee_hours') return null;
  try {
    var parsed = JSON.parse(resStr);
    if (parsed && parsed.preview === true && Array.isArray(parsed.changes) && parsed.changes.length) {
      return 'About to set ' + parsed.changes.length + ':\\n'
        + parsed.changes.map(function(c){ return '- ' + c.employee + ' ' + c.date + ': ' + c.current + ' -> ' + c.proposed; }).join('\\n')
        + '\\nConfirm all?';
    }
  } catch(e) {}
  return null;
}"""

SUMMARY_ERROR_OLD = """function _claireErrorSummary(toolName, resStr) {
  if (typeof resStr !== 'string') return null;"""

SUMMARY_ERROR_NEW = """function _claireErrorSummary(toolName, resStr) {
  if (typeof resStr !== 'string') return null;
  if (toolName === 'send_portal_invite' || toolName === 'send_password_reset_link') {
    try {
      var plParsed = JSON.parse(resStr);
      if (plParsed && plParsed.kind === 'ambiguous_employee') return 'Couldn\\'t tell which employee you meant by "' + plParsed.query + '".';
      if (plParsed && plParsed.kind === 'employee_not_found') return 'Couldn\\'t find an employee named "' + plParsed.query + '".';
      if (plParsed && plParsed.kind === 'no_employees_specified') return 'Need at least one employee name, or all=true.';
    } catch (e) {}
  }"""

apply_edits([
    ("add _claireSendPortalLinks shared orchestration function", ORCH_ANCHOR_OLD, ORCH_ANCHOR_NEW),
    ("add send_portal_invite / send_password_reset_link dispatch branch", DISPATCH_ANCHOR_OLD, DISPATCH_ANCHOR_NEW),
    ("_claireWriteSummary: add portal-link cases", SUMMARY_WRITE_OLD, SUMMARY_WRITE_NEW),
    ("_clairePreviewSummary: add portal-link cases", SUMMARY_PREVIEW_OLD, SUMMARY_PREVIEW_NEW),
    ("_claireErrorSummary: add portal-link cases", SUMMARY_ERROR_OLD, SUMMARY_ERROR_NEW),
])
