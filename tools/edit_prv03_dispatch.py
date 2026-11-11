#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- wires the resolvers into
_claireDispatchOrPropose itself (the ONE place every gated tool call
passes through before a claire_proposals row is created).

For the 4 job-write tools (cancel/uncancel/move/schedule_clean):
resolve client + the specific job up front; on failure, return a plain
message and create NO proposal at all; on success, build the summary
from the resolved record and store the resolved ids in args (the
column is already jsonb -- no migration).

For the other client-/employee-taking gated tools: same ambiguity-safe
resolution, reusing the existing per-tool _claireProposalSummary
templates but with the model's raw name swapped for the resolved real
one, so "a client"/"an employee" can never appear again.

STEP 4 (Claire's own reply after creating a proposal must name the
client/date) falls out of this for free: _claireDispatchOrPropose's own
"Proposal created for ..." text already interpolates `summary`, which
is now always the resolved, specific one.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  var summary = _claireProposalSummary(toolCall.name, toolCall.input || {});
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
    }).select().single();"""

NEW = """  // Claire proposal-resolve-verify (bug #1): resolve the real target
  // BEFORE a proposal is created, so the summary is always built from a
  // verified database record instead of raw, unchecked model input. If
  // nothing resolves, no proposal is created at all.
  var _rawInput = toolCall.input || {};
  var _resolvedSummary = null;
  var _resolvedArgsExtra = null;

  if (toolCall.name === 'cancel_clean' || toolCall.name === 'uncancel_clean') {
    var _rj = _claireResolveClientJob(_rawInput, toolCall.name === 'uncancel_clean');
    if (!_rj.ok) return _claireResolveFailureMessage(_rj, toolCall.name === 'uncancel_clean' ? 'uncancel' : 'cancel');
    _resolvedSummary = _claireResolvedSummary(toolCall.name, _rj);
    _resolvedArgsExtra = { _resolvedClientId: _rj.client.id, _resolvedJobId: _rj.job.id, _resolvedDate: _rj.dateKey };
  } else if (toolCall.name === 'move_clean') {
    var _rm = _claireResolveMoveClean(_rawInput);
    if (!_rm.ok) return _claireResolveFailureMessage(_rm, 'move');
    _resolvedSummary = _claireResolvedSummary('move_clean', _rm);
    _resolvedArgsExtra = { _resolvedClientId: _rm.client.id, _resolvedJobId: _rm.job.id, _resolvedToDate: _rm.toDate, _resolvedTime: _rm.time, _resolvedTeam: _rm.team };
  } else if (toolCall.name === 'schedule_clean') {
    var _rs = _claireResolveScheduleClean(_rawInput);
    if (!_rs.ok) return _claireResolveFailureMessage(_rs, 'schedule');
    _resolvedSummary = _claireResolvedSummary('schedule_clean', _rs);
    _resolvedArgsExtra = { _resolvedClientId: _rs.client.id, _resolvedDate: _rs.date, _resolvedTime: _rs.time, _resolvedTeam: _rs.team };
  } else if (CLAIRE_CLIENT_FIELD_TOOLS[toolCall.name]) {
    var _rc = _claireResolveClientOnly(_rawInput);
    if (!_rc.ok) return _claireResolveFailureMessage(_rc, toolCall.name);
    _resolvedArgsExtra = { _resolvedClientId: _rc.client.id };
    _resolvedSummary = _claireProposalSummary(toolCall.name, Object.assign({}, _rawInput, { client: ((_rc.client.fn || '') + ' ' + (_rc.client.ln || '')).trim() }));
  } else if (CLAIRE_EMPLOYEE_FIELD_TOOLS[toolCall.name]) {
    var _re = _claireResolveEmployeeOnly(_rawInput, _rawInput.date);
    if (!_re.ok) return _claireResolveFailureMessage(_re, toolCall.name);
    _resolvedArgsExtra = { _resolvedEmployeeId: _re.employee.id };
    _resolvedSummary = _claireProposalSummary(toolCall.name, Object.assign({}, _rawInput, { employee: _re.employee.name }));
  }

  var summary = _resolvedSummary || _claireProposalSummary(toolCall.name, _rawInput);
  var argsToStore = _resolvedArgsExtra ? Object.assign({}, _rawInput, _resolvedArgsExtra) : _rawInput;
  var row;
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) throw new Error('Supabase client not ready');
    var ins = await sb.from('claire_proposals').insert({
      business_id: session.businessId,
      created_by: session.authUserId,
      conversation_id: (typeof _claireActiveConversationId === 'string') ? _claireActiveConversationId : null,
      tool_name: toolCall.name,
      args: argsToStore,
      summary: summary,
      risk: meta.sensitive ? 'sensitive' : 'normal'
    }).select().single();"""

EDITS = [("Claire proposal-resolve-verify: resolve-before-propose in _claireDispatchOrPropose", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
