#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 4C prep.
Extracts the pure array-transform logic inside _claireSanitizeHistoryForApi
into a new _claireSanitizeMessagesArray(messages) function that takes an
array and RETURNS a new one, with no dependency on the global
_claireHistory. _claireSanitizeHistoryForApi becomes a one-line wrapper
around it (identical behavior, zero change to any existing call site).
This lets the saved-conversation loader (STEP 4C) reuse the exact same
repair logic on a freshly-loaded row's messages array.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function _claireSanitizeHistoryForApi() {
  var start = 0;
  while (start < _claireHistory.length) {
    var m0 = _claireHistory[start];
    if (m0 && m0.role === 'user' && typeof m0.content === 'string') break;
    start++;
  }
  var src = start < _claireHistory.length ? _claireHistory.slice(start) : _claireHistory.slice();

  var out = [];
  for (var i = 0; i < src.length; i++) {
    var msg = src[i];
    var toolUseIds = (msg && msg.role === 'assistant' && Array.isArray(msg.content))
      ? msg.content.filter(function(b){ return b && b.type === 'tool_use'; }).map(function(b){ return b.id; })
      : [];
    if (toolUseIds.length) {
      var next = src[i + 1];
      var nextIds = (next && next.role === 'user' && Array.isArray(next.content))
        ? next.content.filter(function(b){ return b && b.type === 'tool_result'; }).map(function(b){ return b.tool_use_id; })
        : [];
      var pairsUp = toolUseIds.length === nextIds.length && toolUseIds.every(function(id){ return nextIds.indexOf(id) !== -1; });
      if (pairsUp) { out.push(msg); out.push(next); i++; continue; }
      // Broken pair. Drop this assistant tool_use message; if the very
      // next message is itself a tool_result block (just not one that
      // matches), drop it too -- it can't stand alone.
      if (next && next.role === 'user' && Array.isArray(next.content) && next.content.length && next.content[0] && next.content[0].type === 'tool_result') { i++; }
      continue;
    }
    if (msg && msg.role === 'user' && Array.isArray(msg.content) && msg.content.length && msg.content[0] && msg.content[0].type === 'tool_result') {
      continue; // orphaned tool_result with nothing valid before it
    }
    out.push(msg);
  }
  _claireHistory = out;
}"""

NEW = """// Pure array transform -- takes any messages array (the live
// _claireHistory, or a freshly-loaded saved conversation's row.messages)
// and RETURNS a new, repaired array. No dependency on any global, so a
// saved-conversation load (STEP 4C) can run a loaded row through the
// exact same repair rules before ever replaying it to the model.
function _claireSanitizeMessagesArray(messages) {
  var all = Array.isArray(messages) ? messages : [];
  var start = 0;
  while (start < all.length) {
    var m0 = all[start];
    if (m0 && m0.role === 'user' && typeof m0.content === 'string') break;
    start++;
  }
  var src = start < all.length ? all.slice(start) : all.slice();

  var out = [];
  for (var i = 0; i < src.length; i++) {
    var msg = src[i];
    var toolUseIds = (msg && msg.role === 'assistant' && Array.isArray(msg.content))
      ? msg.content.filter(function(b){ return b && b.type === 'tool_use'; }).map(function(b){ return b.id; })
      : [];
    if (toolUseIds.length) {
      var next = src[i + 1];
      var nextIds = (next && next.role === 'user' && Array.isArray(next.content))
        ? next.content.filter(function(b){ return b && b.type === 'tool_result'; }).map(function(b){ return b.tool_use_id; })
        : [];
      var pairsUp = toolUseIds.length === nextIds.length && toolUseIds.every(function(id){ return nextIds.indexOf(id) !== -1; });
      if (pairsUp) { out.push(msg); out.push(next); i++; continue; }
      // Broken pair. Drop this assistant tool_use message; if the very
      // next message is itself a tool_result block (just not one that
      // matches), drop it too -- it can't stand alone.
      if (next && next.role === 'user' && Array.isArray(next.content) && next.content.length && next.content[0] && next.content[0].type === 'tool_result') { i++; }
      continue;
    }
    if (msg && msg.role === 'user' && Array.isArray(msg.content) && msg.content.length && msg.content[0] && msg.content[0].type === 'tool_result') {
      continue; // orphaned tool_result with nothing valid before it
    }
    out.push(msg);
  }
  return out;
}

function _claireSanitizeHistoryForApi() {
  _claireHistory = _claireSanitizeMessagesArray(_claireHistory);
}"""

EDITS = [("Claire: extract pure _claireSanitizeMessagesArray from _claireSanitizeHistoryForApi", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
