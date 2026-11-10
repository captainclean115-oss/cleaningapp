#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 3A.
Classifies every one of the 32 CLAIRE_TOOLS as gate/no-gate + sensitive,
plus the small session/role helpers the gate needs. Inserted right after
the CLAIRE_TOOLS array closes, before processVoiceCommand.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  { name: 'send_response_to', description: 'Send a text-message version of an answer to Tom (recipient="me") or to a named employee (recipient="<employee first name>"). Renders an SMS button in the chat that opens the RingCentral SMS composer pre-filled. Use when Tom says "text me this", "send this to Lisa", or similar. Always confirm what is about to be sent before calling this when content is long.', input_schema: { type:'object', properties: { recipient:{type:'string',description:'"me" for Tom, or an employee first name (e.g. "Lisa")'}, via:{type:'string',description:'"sms" — only SMS supported today'}, content:{type:'string',description:'The message body to send (plain text, no markdown)'} }, required:['recipient','content'] } }
];

async function processVoiceCommand(text) {"""

NEW = """  { name: 'send_response_to', description: 'Send a text-message version of an answer to Tom (recipient="me") or to a named employee (recipient="<employee first name>"). Renders an SMS button in the chat that opens the RingCentral SMS composer pre-filled. Use when Tom says "text me this", "send this to Lisa", or similar. Always confirm what is about to be sent before calling this when content is long.', input_schema: { type:'object', properties: { recipient:{type:'string',description:'"me" for Tom, or an employee first name (e.g. "Lisa")'}, via:{type:'string',description:'"sms" -- only SMS supported today'}, content:{type:'string',description:'The message body to send (plain text, no markdown)'} }, required:['recipient','content'] } }
];

// -----------------------------------------------------------------------
// CLAIRE SAFETY FOUNDATION (Stage 2a) -- approval-gate classification.
// Every one of the 32 tools above is classified here:
//   gate: false -- runs immediately via executeClaireToolCall, exactly as
//                  before this stage (every READ, plus the 3 draft-only
//                  tools that never touch the database -- a human still
//                  has to tap send in their own phone app for those).
//   gate: true  -- a real WRITE. Intercepted before executeClaireToolCall
//                  runs: a claire_proposals row is created instead, and
//                  nothing changes until a human taps Approve.
//   sensitive: true -- owner/admin only, even to CREATE the proposal.
// batch_edit_employee_hours is special-cased (previewGate) because its
// own confirmed:false call already performs zero writes -- gating that
// call too would block Claire from ever showing the preview at all.
// Only the confirmed:true call needs gating.
// schedule_clean is special-cased (scheduleSpecial) because it already
// renders its OWN confirm UI (the #voice-cmd-status Yes/No panel) and
// defers the actual write to executeScheduleCmd() on a button tap -- see
// _claireApproveProposal's schedule_clean branch for how Approve drives
// that existing, unmodified flow instead of showing a second Yes/No panel.
// -----------------------------------------------------------------------
var CLAIRE_TOOL_META = {
  // READS -- unaffected by this stage.
  lookup_client:               { gate: false },
  lookup_schedule:              { gate: false },
  lookup_balance:                { gate: false },
  lookup_employee:               { gate: false },
  count_jobs:                    { gate: false },
  get_revenue:                   { gate: false },
  compute_quote:                 { gate: false },
  get_employee_hours:            { gate: false },
  locate_team:                   { gate: false },
  query_clients:                 { gate: false },
  revenue_summary:               { gate: false },
  accounts_receivable_summary:   { gate: false },
  cancellation_analysis:         { gate: false },
  team_performance:              { gate: false },
  at_risk_clients:               { gate: false },

  // EXEMPT -- draft-only, no DB mutation; a human taps send in their own app.
  send_message:                  { gate: false },
  send_invoice:                  { gate: false },
  send_response_to:              { gate: false },

  // WRITES -- gated behind a claire_proposals row.
  schedule_clean:                { gate: true,  sensitive: false, scheduleSpecial: true },
  cancel_clean:                  { gate: true,  sensitive: false },
  move_clean:                    { gate: true,  sensitive: false },
  employee_day_off:              { gate: true,  sensitive: false },
  move_employee:                 { gate: true,  sensitive: false },
  add_reminder:                  { gate: true,  sensitive: false },
  change_frequency:              { gate: true,  sensitive: false },
  update_client_notes:           { gate: true,  sensitive: false },
  edit_client:                   { gate: true,  sensitive: false },
  send_text:                     { gate: true,  sensitive: false },
  change_price:                  { gate: true,  sensitive: true  },
  record_payment:                { gate: true,  sensitive: true  },
  edit_employee_hours:           { gate: true,  sensitive: true  },
  batch_edit_employee_hours:     { gate: true,  sensitive: true, previewGate: true }
};

// Any tool not listed above fails SAFE: gated + sensitive -- a future new
// tool is never accidentally exempt just because this object wasn't
// updated for it. This is the one place anything reads CLAIRE_TOOL_META.
function _claireToolMeta(name) {
  return CLAIRE_TOOL_META[name] || { gate: true, sensitive: true };
}

// Synchronous session snapshot the gate needs on every dispatch. Mirrors
// the existing getCurrentAppRole()/PentaTenant.current() accessors used
// everywhere else in the app -- no new auth plumbing.
function _claireSessionInfo() {
  var blob = _pentaParseAuthToken();
  var authUserId = (blob && blob.user && blob.user.id) || null;
  return {
    authUserId: authUserId,
    businessId: (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null,
    role: (typeof getCurrentAppRole === 'function') ? getCurrentAppRole() : null
  };
}
function _claireIsOwnerOrAdmin(role) {
  return role === 'owner' || role === 'admin';
}

async function processVoiceCommand(text) {"""

EDITS = [("Claire: CLAIRE_TOOL_META classification + session helpers", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
