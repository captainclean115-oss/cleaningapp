// Bug report (Sept 2026, Tom's Sunday payroll session): a batch hours-edit
// conversation with Claire ("preview -> override -> is it done? -> retry ->
// yes") crashed mid-flow with:
//   messages.0.content.0: unexpected tool_use_id found in tool_result
//   blocks: toolu_01QYLFkd7iLC5K6keABQ8HPQ. Each tool_result block must
//   have a corresponding tool_use block in the previous message.
// Before that hard crash, Claire also silently denied ever having received
// times she'd already previewed ("I never received the times you want to
// set"), and the DB was verified to have zero rows in manual_hour_overrides
// for the batch Tom confirmed.
//
// Root cause: processVoiceCommand capped Claire's conversation history with
// a flat `_claireHistory.slice(-24)` -- a raw message-count cutoff with no
// awareness that Anthropic requires every tool_result block to be preceded
// immediately, in the same array, by the assistant message carrying the
// matching tool_use block. Whenever the number of messages trimmed off the
// front happened to be even, the cut landed exactly between a tool_use
// assistant message and its answering tool_result user message, leaving
// the tool_result as the new first array element with no tool_use anywhere
// in the (now-shorter) array -- precisely the 400 above. On cuts that
// missed a pair boundary by one, it silently dropped the user's own
// message (the one with the actual times) while leaving the rest of the
// array well-formed -- no error, just amnesia.
//
// Fix: _claireTrimHistory() only ever cuts at a genuine turn boundary (a
// 'user' message with plain-string content -- something the operator
// actually typed), and leaves the array untouched for that round if no
// such boundary exists in the trimmable range, rather than risk an
// unsafe cut.
//
// This test extracts _claireTrimHistory and _claireWriteSummary verbatim
// from index.html and exercises them directly -- no mocking of their
// internals, no reimplementation of the trimming logic.
//
// Run with: node tests/claire-history-trim-tool-pairing.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}

const trimSrc = extract(
  'function _claireTrimHistory(maxMessages) {',
  '\n// Bug fix (same payroll-session report): the MAX_TOOL_ROUNDS fallback'
);
const writeSummarySrc = extract(
  'function _claireWriteSummary(toolName, resStr) {',
  '\nfunction setClaireApiKey()'
);

// -- helpers to build realistic history shapes --------------------------
function userText(text) { return { role: 'user', content: text }; }
function assistantToolUse(id) { return { role: 'assistant', content: [{ type: 'tool_use', id: id, name: 'batch_edit_employee_hours', input: {} }] }; }
function assistantText(text) { return { role: 'assistant', content: [{ type: 'text', text: text }] }; }
function userToolResult(id) { return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }; }

// Every tool_result's tool_use_id must be answerable by SOME tool_use
// earlier in the (possibly-trimmed) array -- this is the actual invariant
// Anthropic enforces and the one the real bug violated.
function firstMessageIsOrphanToolResult(history) {
  if (!history.length) return false;
  const m0 = history[0];
  return m0.role === 'user' && Array.isArray(m0.content) && m0.content[0] && m0.content[0].type === 'tool_result';
}
function everyToolResultHasPriorToolUse(history) {
  const seenToolUseIds = new Set();
  for (const m of history) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_use') seenToolUseIds.add(b.id);
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && !seenToolUseIds.has(b.tool_use_id)) return false;
      }
    }
  }
  return true;
}

function runTrim(history, maxMessages) {
  const sandbox = { _claireHistory: history.slice() };
  vm.createContext(sandbox);
  vm.runInContext(trimSrc + '\n_claireTrimHistory(' + maxMessages + ');', sandbox);
  return sandbox._claireHistory;
}

// -- Reproduce the exact failure shape: a long back-and-forth of tool ----
// rounds (mirrors a real multi-date batch confirm conversation), trimmed
// at every possible cap from 2 up to the full length, exactly as would
// happen incrementally across many turns of a real session.
function buildRealisticHistory(rounds) {
  const h = [userText('set everyone\'s hours for the week')];
  for (let i = 0; i < rounds; i++) {
    const id = 'toolu_' + i;
    h.push(assistantToolUse(id));
    h.push(userToolResult(id));
  }
  h.push(assistantText('Saved hours for Fatima, Franchesca, Nadia and Natalia. Done.'));
  return h;
}

const full = buildRealisticHistory(15); // 1 + 15*2 + 1 = 32 messages, same order of magnitude as the real session
let anyOrphanAcrossAllCaps = false;
for (let cap = 2; cap <= full.length; cap++) {
  const trimmed = runTrim(full, cap);
  if (firstMessageIsOrphanToolResult(trimmed)) anyOrphanAcrossAllCaps = true;
  if (!everyToolResultHasPriorToolUse(trimmed)) anyOrphanAcrossAllCaps = true;
}
check('trimming at every possible cap (2..32) on a realistic 32-message tool-call history never orphans a tool_result', !anyOrphanAcrossAllCaps);

// -- The exact parity case that triggered the original bug: an EVEN ------
// number of messages trimmed off the front, which under the old flat
// slice(-24) always landed between a tool_use and its tool_result.
const evenTrimCase = buildRealisticHistory(6); // length 14
const trimmedEven = runTrim(evenTrimCase, 8); // trims 6 (even) off the front
check('even-parity trim (the exact old-bug case) does not produce an orphan tool_result at position 0', !firstMessageIsOrphanToolResult(trimmedEven));
check('even-parity trim keeps every tool_result answerable', everyToolResultHasPriorToolUse(trimmedEven));

// -- No safe boundary exists anywhere in the trimmable range: must NOT ---
// gut the history to something malformed (or empty) -- skip trimming.
const noBoundary = [assistantToolUse('a'), userToolResult('a'), assistantToolUse('b'), userToolResult('b')];
const trimmedNoBoundary = runTrim(noBoundary, 1);
check('with no safe turn boundary in range, history is left untouched rather than corrupted', trimmedNoBoundary.length === noBoundary.length);
check('the untouched history still has no orphan tool_result', everyToolResultHasPriorToolUse(trimmedNoBoundary));

// -- A safe boundary DOES exist further back than the naive cut point: ---
// the function must find it, not give up just because the exact target
// index isn't a real turn boundary.
const withBoundary = [userText('earlier turn'), assistantToolUse('x'), userToolResult('x'), userText('later turn'), assistantToolUse('y'), userToolResult('y')];
const trimmedWithBoundary = runTrim(withBoundary, 2); // naive cut would land inside the x pair
check('trimming advances past an unsafe cut point to the next real turn boundary', trimmedWithBoundary[0].role === 'user' && typeof trimmedWithBoundary[0].content === 'string');
check('the advanced trim still answers every tool_result', everyToolResultHasPriorToolUse(trimmedWithBoundary));

// -- Below the cap: no trimming happens at all. -------------------------
const short = buildRealisticHistory(2);
const trimmedShort = runTrim(short, 100);
check('history below the cap is returned unchanged', trimmedShort.length === short.length);

// -- _claireWriteSummary: the "what actually saved" reporting that -------
// replaces the old vague "anything still left to handle?" line.
function runWriteSummary(toolName, resStr) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(writeSummarySrc + '\nvar __r = _claireWriteSummary(' + JSON.stringify(toolName) + ', ' + JSON.stringify(resStr) + ');', sandbox);
  return sandbox.__r;
}

const batchSuccess = JSON.stringify({ success: true, count: 2, updated: [{ employee: 'Nadia Barros', date: '2026-08-10' }, { employee: 'Fatima Staff', date: '2026-08-10' }] });
check('batch success produces a concrete saved-who/when summary', runWriteSummary('batch_edit_employee_hours', batchSuccess) === 'Saved hours for Nadia Barros (2026-08-10), Fatima Staff (2026-08-10).');

const batchPreview = JSON.stringify({ preview: true, changes: [] });
check('a preview-only batch result (no write happened) produces no summary', runWriteSummary('batch_edit_employee_hours', batchPreview) === null);

const batchFailure = JSON.stringify({ error: 'batch_write_failed', failed_at: {} });
check('a failed batch write produces no summary (never implied success)', runWriteSummary('batch_edit_employee_hours', batchFailure) === null);

const singleEditSuccess = "Updated Nadia Barros's hours for Monday Aug 10: start: 09:10, end: 19:22, lunch: 10min. Total: 10.0h. Verified by reading it back. Done.";
check('single-entry edit success produces a summary', runWriteSummary('edit_employee_hours', singleEditSuccess).startsWith('Updated Nadia Barros'));

check('a non-write tool (e.g. lookup) produces no summary', runWriteSummary('get_employee_hours', 'Nadia worked 9-5.') === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
