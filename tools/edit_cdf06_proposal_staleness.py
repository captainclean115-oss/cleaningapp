#!/usr/bin/env python3
"""Claire-draft-and-fallback fix -- PART D (stale proposal cards).

BUG (Tom): a proposal card from Nov 11 still shows "Cancel a client's
clean on 2026-11-11" with live Approve/Reject buttons -- vague because
it predates the resolve-before-propose fix (PR #225, merged 2026-11-11
17:59 ET; this row was created 16:37 ET, before that), and still
"live" because nothing ever treated an old pending card differently
from a fresh one.

Fix: a pending proposal is STALE when either its formal expires_at
(48h TTL) has passed, OR -- a new check -- its own action date has
already gone by (approving "cancel a clean on Nov 11" makes no sense
once Nov 11 is already over, independent of the 48h clock). A stale
card renders as "Expired" with no live Approve button, only a Dismiss
button that removes it. Approve's own existing expiry check now uses
the same shared rule, and both Approve-on-expiry and a normal Reject
remove the card from the chat instead of leaving a decided card
sitting there as clutter.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_CARD_HTML = """function _claireProposalCardHtml(row) {
  var riskBadge = row.risk === 'sensitive' ? '<span style="background:rgba(248,113,113,0.15);color:#f87171;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:6px">SENSITIVE</span>' : '';
  return '<div class="claire-proposal-card" id="claire-proposal-' + row.id + '" style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-top:6px;background:var(--surface2)">'
    + '<div style="font-size:13px;line-height:1.4"><strong>Proposal</strong>' + riskBadge + '<br>' + _claireEscapeHtml(row.summary) + '</div>'
    + '<div class="claire-proposal-status" style="font-size:12px;color:var(--muted);margin-top:6px">Waiting for your approval. Nothing has changed yet.</div>'
    + '<div style="display:flex;gap:8px;margin-top:10px">'
    + '<button onclick="_claireRejectProposal(\\'' + row.id + '\\')" style="flex:1;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--muted);font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:600;cursor:pointer">Reject</button>'
    + '<button onclick="_claireApproveProposal(\\'' + row.id + '\\')" style="flex:1;padding:10px;background:var(--green);border:none;border-radius:10px;color:#000;font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:700;cursor:pointer">Approve</button>'
    + '</div>'
    + '</div>';
}"""

NEW_CARD_HTML = """// Claire-draft-and-fallback fix: a PENDING proposal is stale when
// either its formal 48h TTL (expires_at) has passed, or -- a check
// expires_at alone never caught -- its own action date has already
// gone by. Approving "cancel a clean on Nov 11" makes no sense once
// Nov 11 is already over, regardless of how many hours old the card
// itself is. Only ever meaningful for a 'pending' row; a row already
// decided (approved/rejected/executed/failed/expired) is never "live"
// in the first place, so it is never "stale" either -- it just is
// whatever it already became.
function _claireProposalIsStale(row) {
  if (!row || row.status !== 'pending') return false;
  if (row.expires_at && new Date() > new Date(row.expires_at)) return true;
  var args = row.args || {};
  var actionDate = args._resolvedDate || args._resolvedToDate || args.date || args.to_date;
  if (actionDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(actionDate)) {
    var todayKey = (typeof _claireTodayKey === 'function') ? _claireTodayKey() : null;
    if (todayKey && actionDate < todayKey) return true;
  }
  return false;
}

function _claireProposalCardHtml(row) {
  var riskBadge = row.risk === 'sensitive' ? '<span style="background:rgba(248,113,113,0.15);color:#f87171;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:6px">SENSITIVE</span>' : '';
  if (_claireProposalIsStale(row)) {
    return '<div class="claire-proposal-card" id="claire-proposal-' + row.id + '" style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-top:6px;background:var(--surface2)">'
      + '<div style="font-size:13px;line-height:1.4"><strong>Proposal</strong>' + riskBadge + '<br>' + _claireEscapeHtml(row.summary) + '</div>'
      + '<div class="claire-proposal-status" style="font-size:12px;color:var(--muted);margin-top:6px">Expired -- too old to act on. Ask Claire again if you still want this.</div>'
      + '<div style="display:flex;gap:8px;margin-top:10px">'
      + '<button onclick="_claireRejectProposal(\\'' + row.id + '\\')" style="flex:1;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--muted);font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:600;cursor:pointer">Dismiss</button>'
      + '</div>'
      + '</div>';
  }
  return '<div class="claire-proposal-card" id="claire-proposal-' + row.id + '" style="border:1px solid var(--border);border-radius:12px;padding:12px;margin-top:6px;background:var(--surface2)">'
    + '<div style="font-size:13px;line-height:1.4"><strong>Proposal</strong>' + riskBadge + '<br>' + _claireEscapeHtml(row.summary) + '</div>'
    + '<div class="claire-proposal-status" style="font-size:12px;color:var(--muted);margin-top:6px">Waiting for your approval. Nothing has changed yet.</div>'
    + '<div style="display:flex;gap:8px;margin-top:10px">'
    + '<button onclick="_claireRejectProposal(\\'' + row.id + '\\')" style="flex:1;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;color:var(--muted);font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:600;cursor:pointer">Reject</button>'
    + '<button onclick="_claireApproveProposal(\\'' + row.id + '\\')" style="flex:1;padding:10px;background:var(--green);border:none;border-radius:10px;color:#000;font-family:\\'DM Sans\\',sans-serif;font-size:13px;font-weight:700;cursor:pointer">Approve</button>'
    + '</div>'
    + '</div>';
}"""

OLD_APPROVE_TTL = """    if (new Date(row.expires_at) < new Date()) {
      await sb.from('claire_proposals').update({ status: 'expired' }).eq('id', id).eq('status', 'pending');
      if (statusEl) statusEl.textContent = 'This is out of date, ask Claire again.';
      return;
    }"""

NEW_APPROVE_TTL = """    if (_claireProposalIsStale(row)) {
      await sb.from('claire_proposals').update({ status: 'expired' }).eq('id', id).eq('status', 'pending');
      if (statusEl) statusEl.textContent = 'This is out of date, ask Claire again.';
      if (card) card.remove();
      return;
    }"""

OLD_REJECT = """    if (upd.error || !upd.data) {
      if (statusEl) statusEl.textContent = 'Already decided.';
      return;
    }
    if (statusEl) statusEl.textContent = 'Rejected.';
  } catch (e) {
    console.error('[claire] reject failed', e);"""

NEW_REJECT = """    if (upd.error || !upd.data) {
      if (statusEl) statusEl.textContent = 'Already decided.';
      return;
    }
    if (statusEl) statusEl.textContent = 'Rejected.';
    if (card) card.remove();
  } catch (e) {
    console.error('[claire] reject failed', e);"""

EDITS = [
    ("Claire-draft-and-fallback fix: add _claireProposalIsStale + branch card HTML on it", OLD_CARD_HTML, NEW_CARD_HTML),
    ("Claire-draft-and-fallback fix: Approve's TTL check uses the shared staleness rule", OLD_APPROVE_TTL, NEW_APPROVE_TTL),
    ("Claire-draft-and-fallback fix: Reject removes the card from the chat", OLD_REJECT, NEW_REJECT),
]

if __name__ == "__main__":
    apply_edits(EDITS)
