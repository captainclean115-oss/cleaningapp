#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 3C/D/E.
Inserts the approval-gate dispatcher, proposal-summary builder, proposal
card renderer, and Approve/Reject/Approve-all handlers right after
executeClaireToolCall's own (unmodified) definition. Also rewires the
ONE live call site (processVoiceCommand's tool-execution loop) to call
the new gate instead of executeClaireToolCall directly.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_AFTER_EXEC = """async function executeClaireToolCall(toolCall, message) {
  _claireActing = true;
  _claireLastToolResult = '';
  try { await _executeClaireToolCallInner(toolCall, message); }
  finally { setTimeout(function(){ _claireActing = false; }, 0); }
  return _claireLastToolResult || ('Executed ' + toolCall.name + '.');
}

// When a pending action (schedule/invoice/SMS) is later confirmed by Tom"""

NEW_AFTER_EXEC = """async function executeClaireToolCall(toolCall, message) {
  _claireActing = true;
  _claireLastToolResult = '';
  try { await _executeClaireToolCallInner(toolCall, message); }
  finally { setTimeout(function(){ _claireActing = false; }, 0); }
  return _claireLastToolResult || ('Executed ' + toolCall.name + '.');
}

// -----------------------------------------------------------------------
// CLAIRE SAFETY FOUNDATION (Stage 2a) -- approval gate.
// The ONE live call site in processVoiceCommand's tool-execution loop
// calls _claireDispatchOrPropose instead of executeClaireToolCall
// directly. A READ (or the batch preview-only call) falls straight
// through to the unmodified executeClaireToolCall, exactly as before.
// A real WRITE never executes here -- it becomes a pending
// claire_proposals row, and executeClaireToolCall only runs later, from
// _claireApproveProposal, completely unmodified.
// -----------------------------------------------------------------------

// Cards built during the current turn, flushed right after the turn's
// one wrap-up reply -- same pattern as the existing _claireLastToolSmsLink
// (rendered as a bubble AFTER Claire's text, never mid-silent-loop).
var _clairePendingProposals = []; // { id, html, sensitive }

async function _claireDispatchOrPropose(toolCall, textReply) {
  var meta = _claireToolMeta(toolCall.name);

  if (!meta.gate) {
    return await executeClaireToolCall(toolCall, textReply);
  }
  if (meta.previewGate && !(toolCall.input && toolCall.input.confirmed)) {
    // Preview-only call -- writes nothing, matches today's behavior exactly.
    return await executeClaireToolCall(toolCall, textReply);
  }

  var session = _claireSessionInfo();
  if (!session.authUserId || !session.businessId) {
    return 'Your session looks signed out -- sign in again and try that once more. Nothing was changed.';
  }
  if (meta.sensitive && !_claireIsOwnerOrAdmin(session.role)) {
    return 'Only the owner or admin can do that.';
  }
  // Should be unreachable (Claire never loads for an employee, and the
  // employee portal never reaches this code path at all), but fails safe
  // if some future routing change ever let an employee session get here.
  if (!isManagerRole() && session.role !== 'dispatcher') {
    return 'Only a manager or above can ask Claire to do that.';
  }

  var summary = _claireProposalSummary(toolCall.name, toolCall.input || {});
  var row;
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) throw new Error('Supabase client not ready');
    var ins = await sb.from('claire_proposals').insert({
      business_id: session.businessId,
      created_by: session.authUserId,
      conversation_id: (typeof _claireActiveConversationId === 'string') ? _claireActiveConversationId : null,
      tool_name: toolCall.name,
      args: toolCall.input || {},
      summary: summary,
      risk: meta.sensitive ? 'sensitive' : 'normal'
    }).select().single();
    if (ins.error) throw new Error(ins.error.message);
    row = ins.data;
  } catch (propErr) {
    console.error('[claire] failed to create proposal:', propErr);
    return 'I couldn\\'t create that proposal just now (' + (propErr && propErr.message ? propErr.message : 'unknown error') + '). Nothing was changed -- try again?';
  }

  _clairePendingProposals.push({ id: row.id, html: _claireProposalCardHtml(row), sensitive: !!meta.sensitive });
  _claireRefreshProposalBadge();
  return 'Proposal created for "' + summary + '" -- waiting for your approval. Nothing has changed yet.';
}

// Plain-English, screen-level-of-detail summary for a proposal card.
// Deliberately mirrors the wording each tool's OWN existing confirmed
// reply already uses -- nothing here shows more than the app's normal
// screens already would.
function _claireProposalSummary(toolName, input) {
  input = input || {};
  switch (toolName) {
    case 'schedule_clean':
      return 'Schedule ' + (input.client || 'a client') + (input.date ? ' for ' + input.date : '') + (input.time ? ' at ' + input.time : '') + (input.team ? ' with Team ' + String(input.team).toUpperCase() : '') + '.';
    case 'cancel_clean':
      return 'Cancel ' + (input.client || 'a client') + '\\'s clean' + (input.date ? ' on ' + input.date : '') + '.';
    case 'move_clean':
      return 'Move ' + (input.client || 'a client') + '\\'s clean' + (input.from_date ? ' from ' + input.from_date : '') + (input.to_date ? ' to ' + input.to_date : '') + (input.time ? ' at ' + input.time : '') + (input.team ? ' with Team ' + String(input.team).toUpperCase() : '') + '.';
    case 'employee_day_off':
      return 'Mark ' + (input.employee || 'an employee') + ' off' + (input.date ? ' on ' + input.date : '') + '.';
    case 'move_employee':
      return 'Move ' + (input.employee || 'an employee') + ' to Team ' + (input.team ? String(input.team).toUpperCase() : '?') + (input.date ? ' on ' + input.date : '') + '.';
    case 'add_reminder':
      return 'Add reminder: "' + (input.text || '') + '".';
    case 'change_frequency':
      return 'Change ' + (input.client || 'a client') + '\\'s cleaning frequency to ' + (input.new_frequency || '?') + '.';
    case 'update_client_notes':
      return 'Update notes on ' + (input.client || 'a client') + '\\'s profile.';
    case 'edit_client':
      return 'Edit ' + (input.client || 'a client') + '\\'s ' + (input.field || 'field') + ' to "' + (input.value || '') + '".';
    case 'send_text':
      return 'Send a text to ' + (input.phone || 'this number') + '.';
    case 'change_price':
      return 'Change ' + (input.client || 'a client') + '\\'s price to $' + (input.price || '?') + '.';
    case 'record_payment':
      return 'Record a $' + (input.amount || '?') + ' payment from ' + (input.client || 'a client') + (input.method ? ' via ' + input.method : '') + '.';
    case 'edit_employee_hours':
      return 'Edit ' + (input.employee || 'an employee') + '\\'s hours' + (input.date ? ' on ' + input.date : '') + '.';
    case 'batch_edit_employee_hours':
      var n = Array.isArray(input.entries) ? input.entries.length : 0;
      return 'Edit hours for ' + n + ' employee/date ' + (n === 1 ? 'entry' : 'entries') + '.';
    default:
      return 'Run ' + toolName + '.';
  }
}

function _claireEscapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _claireProposalCardHtml(row) {
  var riskBadge = row.risk === 'sensitive' ? '<span style="background:rgba(248,113,113,0.15);color:#f87171;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:6px">SENSITIVE</span>' : '';
  return '<div class="claire-proposal-card" id="claire-proposal-' + row.id + '" style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-top:6px;background:var(--surface2)">'
    + '<div style="font-size:13px;line-height:1.4"><strong>Proposal</strong>' + riskBadge + '<br>' + _claireEscapeHtml(row.summary) + '</div>'
    + '<div class="claire-proposal-status" style="font-size:12px;color:var(--muted);margin-top:6px">Waiting for your approval. Nothing has changed yet.</div>'
    + '<div style="display:flex;gap:8px;margin-top:10px">'
    + '<button onclick="_claireRejectProposal(\\'' + row.id + '\\')" style="flex:1;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--muted);font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:600;cursor:pointer">Reject</button>'
    + '<button onclick="_claireApproveProposal(\\'' + row.id + '\\')" style="flex:1;padding:10px;background:var(--green);border:none;border-radius:10px;color:#000;font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:700;cursor:pointer">Approve</button>'
    + '</div>'
    + '</div>';
}

// Renders every card queued this turn, then (when 2+ non-sensitive
// proposals landed in the SAME turn) one extra "Approve all" bubble.
// Called right after the turn's one wrap-up claireReply(), same slot as
// the existing _claireRenderSmsButton(_claireLastToolSmsLink) call.
function _claireFlushProposalCards() {
  var nonSensitiveIds = [];
  for (var i = 0; i < _clairePendingProposals.length; i++) {
    _claireRenderBubble('claire', _clairePendingProposals[i].html);
    if (!_clairePendingProposals[i].sensitive) nonSensitiveIds.push(_clairePendingProposals[i].id);
  }
  if (nonSensitiveIds.length >= 2) {
    var idsAttr = nonSensitiveIds.map(function(x){ return '"' + x + '"'; }).join(',');
    _claireRenderBubble('claire', '<button onclick=\\'_claireApproveAllProposals([' + idsAttr + '])\\' style="width:100%;padding:10px;background:var(--green);border:none;border-radius:10px;color:#000;font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:700;cursor:pointer">Approve all ' + nonSensitiveIds.length + '</button>');
  }
  _clairePendingProposals = [];
}

// Approve is double-tap safe and idempotent: the UPDATE that claims the
// row is itself conditioned on status='pending', so only one concurrent
// tap can ever win the claim -- every other tap (or a second tap after
// the first already finished) reads back status != 'pending' and does
// nothing further.
async function _claireApproveProposal(id) {
  var card = document.getElementById('claire-proposal-' + id);
  var statusEl = card ? card.querySelector('.claire-proposal-status') : null;
  var btns = card ? card.querySelectorAll('button') : [];
  var i, bi;
  for (bi = 0; bi < btns.length; bi++) btns[bi].disabled = true;

  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) throw new Error('Supabase client not ready');

    // Lock-screen / expired-session re-check -- a real network round trip,
    // not the locally-cached session, so a session that expired since the
    // card was rendered is actually caught here, not silently ignored.
    var sres = await sb.auth.getSession();
    if (!sres || !sres.data || !sres.data.session) {
      if (statusEl) statusEl.textContent = 'Sign in again to approve.';
      for (bi = 0; bi < btns.length; bi++) btns[bi].disabled = false;
      return;
    }
    var session = _claireSessionInfo();

    var fetched = await sb.from('claire_proposals').select('*').eq('id', id).single();
    if (fetched.error || !fetched.data) {
      if (statusEl) statusEl.textContent = 'Could not find that proposal.';
      return;
    }
    var row = fetched.data;

    if (row.status !== 'pending') {
      if (statusEl) statusEl.textContent = 'Already ' + row.status + '.';
      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      await sb.from('claire_proposals').update({ status: 'expired' }).eq('id', id).eq('status', 'pending');
      if (statusEl) statusEl.textContent = 'This is out of date, ask Claire again.';
      return;
    }
    var meta = _claireToolMeta(row.tool_name);
    if (meta.sensitive && !_claireIsOwnerOrAdmin(session.role)) {
      if (statusEl) statusEl.textContent = 'Only the owner or admin can approve that.';
      return;
    }

    // Claim the row -- conditional on status still being 'pending'. A
    // second, racing tap (or an "Approve all" that re-visits this id)
    // gets back no row here and falls into the "already decided" path,
    // never reaching the execute call below twice.
    var claim = await sb.from('claire_proposals')
      .update({ status: 'approved', decided_by: session.authUserId, decided_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'pending').select().single();
    if (claim.error || !claim.data) {
      if (statusEl) statusEl.textContent = 'Already decided.';
      return;
    }

    if (statusEl) statusEl.textContent = 'Approved -- running now...';

    var toolCall = { name: row.tool_name, input: row.args || {} };
    var resultStr = null;
    var execError = null;
    try {
      if (meta.scheduleSpecial) {
        // schedule_clean's own handler performs no write by itself -- it
        // only renders the legacy Yes/No panel and sets
        // window._pendingVoiceCmd (see CLAIRE_TOOL_META's comment).
        // Approve IS the human confirmation now, so drive that existing,
        // unmodified confirm function directly instead of leaving a
        // second, redundant Yes/No panel on screen.
        resultStr = await executeClaireToolCall(toolCall, null);
        if (window._pendingVoiceCmd) {
          await executeScheduleCmd();
        }
        var stStatus = document.getElementById('voice-cmd-status');
        if (stStatus) stStatus.style.display = 'none';
      } else {
        resultStr = await executeClaireToolCall(toolCall, null);
      }
    } catch (runErr) {
      execError = runErr;
    }

    if (execError) {
      await sb.from('claire_proposals').update({ status: 'failed', error: (execError && execError.message) || String(execError), executed_at: new Date().toISOString() }).eq('id', id);
      if (statusEl) statusEl.textContent = 'Failed: ' + ((execError && execError.message) || 'unknown error') + '.';
    } else {
      await sb.from('claire_proposals').update({ status: 'executed', result: { resultStr: String(resultStr || '') }, executed_at: new Date().toISOString() }).eq('id', id);
      if (statusEl) statusEl.textContent = 'Done.';
    }
  } catch (e) {
    console.error('[claire] approve failed', e);
    if (statusEl) statusEl.textContent = 'Something went wrong approving this.';
  } finally {
    _claireRefreshProposalBadge();
  }
}

async function _claireRejectProposal(id) {
  var card = document.getElementById('claire-proposal-' + id);
  var statusEl = card ? card.querySelector('.claire-proposal-status') : null;
  var btns = card ? card.querySelectorAll('button') : [];
  var bi;
  for (bi = 0; bi < btns.length; bi++) btns[bi].disabled = true;
  try {
    var session = _claireSessionInfo();
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) throw new Error('Supabase client not ready');
    var upd = await sb.from('claire_proposals')
      .update({ status: 'rejected', decided_by: session.authUserId, decided_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'pending').select().single();
    if (upd.error || !upd.data) {
      if (statusEl) statusEl.textContent = 'Already decided.';
      return;
    }
    if (statusEl) statusEl.textContent = 'Rejected.';
  } catch (e) {
    console.error('[claire] reject failed', e);
    if (statusEl) statusEl.textContent = 'Something went wrong.';
    for (bi = 0; bi < btns.length; bi++) btns[bi].disabled = false;
  } finally {
    _claireRefreshProposalBadge();
  }
}

// Sequential, not parallel -- same reasoning as batch_edit_employee_hours:
// a failure partway through leaves a well-defined, visible state instead
// of several racing writes. Each call re-checks role/status/expiry on
// its own, so this is exactly N taps of Approve, just automated.
async function _claireApproveAllProposals(ids) {
  if (!ids || !ids.length) return;
  if (!window.confirm('Approve all ' + ids.length + ' proposals? This runs each one right away.')) return;
  for (var i = 0; i < ids.length; i++) {
    await _claireApproveProposal(ids[i]);
  }
}

// STEP 3F: small "N waiting for approval" badge on Claire's entry point,
// for any role that can actually see proposals (RLS already scopes the
// count query itself -- a manager's count is only her own, an employee's
// is always 0 and the badge is hidden outright for that role).
async function _claireRefreshProposalBadge() {
  try {
    var badge = document.getElementById('claire-proposal-badge');
    if (!badge) return;
    var role = (typeof getCurrentAppRole === 'function') ? getCurrentAppRole() : null;
    if (!role || role === 'employee') { badge.style.display = 'none'; return; }
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) return;
    var res = await sb.from('claire_proposals').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    if (res.error) return;
    var n = res.count || 0;
    if (n > 0) { badge.textContent = String(n > 99 ? '99+' : n); badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  } catch (e) {}
}

// When a pending action (schedule/invoice/SMS) is later confirmed by Tom"""

OLD_CALL_SITE = """          var resStr;
          try {
            resStr = await executeClaireToolCall(tu, textReply);
          } catch (te) {"""

NEW_CALL_SITE = """          var resStr;
          try {
            resStr = await _claireDispatchOrPropose(tu, textReply);
          } catch (te) {"""

EDITS = [
    ("Claire: approval-gate dispatcher + proposal card + approve/reject/approve-all + badge refresh", OLD_AFTER_EXEC, NEW_AFTER_EXEC),
    ("Claire: tool-loop call site now routes through the gate", OLD_CALL_SITE, NEW_CALL_SITE),
]

if __name__ == "__main__":
    apply_edits(EDITS)
