// Bug report: "Claire is returning her generic 'sorry I'm having trouble
// connecting' fallback message immediately instead of processing hours
// edit requests." Investigated whether PR #184 (batch_edit_employee_hours)
// broke tool registration -- it didn't: the new tool's input_schema is
// valid, standard JSON Schema (verified by extracting the real
// CLAIRE_TOOLS array from index.html, JSON.stringify/parse round-tripping
// it cleanly, and confirming it matches Anthropic's documented tool-use
// shape). The dispatcher's own errors (executeClaireToolCall) can't cause
// this symptom either -- they're caught per-tool-call and fed back to the
// model as a tool_result, never reaching the "immediate fallback" paths.
//
// Real, verifiable gap found by code review: when the round-0 call to
// _claireApi() fails (bad tool schema, auth, upstream 5xx, rate limit,
// anything), processVoiceCommand fell back to processVoiceCommandLocal(text)
// with the real error (claireErr) DISCARDED. For a message local parsing
// doesn't recognize (which any hours-editing sentence never will -- local
// parsing only knows schedule/cancel/day-off/remind keywords), the result
// is the same content-free "having trouble connecting" reply regardless of
// WHY the real API failed -- indistinguishable from Claire simply not
// understanding a normal message. That's exactly what made this bug
// unreportable: Tom had nothing concrete beyond "she seems stuck." A
// second, fully silent catch-all (zero console output at all, unlike the
// round-0 catch which at least console.warns) had the same discard-the-
// error problem for any exception in the tool-loop body outside that
// inner try.
//
// Fixed by threading the real error message through to
// processVoiceCommandLocal, which now appends it (in parentheses) ONLY to
// the final generic catch-all reply -- every keyword-recognized local
// command (schedule/cancel/day-off/remind) is completely unaffected, since
// those represent local parsing actually working, not an error state. Also
// added console.error logging to the previously-silent outer catch.
//
// Follow-up (Sept 2026, separate bug report): threading the RAW error
// through turned out to be an over-correction -- Tom started seeing raw
// JSON/"Anthropic status: 400" dumped straight into chat, which is just as
// unreportable to a non-technical operator as the original silent
// fallback, just uglier. Both call sites now pass the error through
// _claireUserFacingError() (a short plain-English translation) instead of
// the raw .message; the full technical detail is still logged, now to both
// console AND audit_log via _claireLogTechnicalError so it survives a page
// reload. See tests/claire-history-trim-tool-pairing.test.js for coverage
// of _claireUserFacingError itself.
//
// This test extracts processVoiceCommandLocal verbatim from index.html and
// exercises both the error-surfacing path and every existing keyword path,
// to prove the fix is additive only. It does NOT (and cannot, in this
// sandbox) prove or disprove that the underlying _claireApi failure is
// specifically about the PR #184 tool schema -- that requires either the
// exact live console error or Supabase edge-function logs, neither
// available here. See the accompanying report for what was ruled out.
//
// Run with: node tests/claire-api-failure-reason-surfaced.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ---- Structural check: the real CLAIRE_TOOLS array (incl. the new batch
// tool) is valid, JSON-serializable, and round-trips cleanly -- rules out
// "malformed tool schema breaks JSON.stringify(body)" as a cause. ----
{
  const start = src.indexOf('var CLAIRE_TOOLS = [');
  const end = src.indexOf('\n];', start) + 3;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end), sandbox);
  const tools = sandbox.CLAIRE_TOOLS;
  check('CLAIRE_TOOLS extracted with a plausible tool count', tools.length > 20, true);
  const batchTool = tools.find(function (t) { return t.name === 'batch_edit_employee_hours'; });
  check('batch_edit_employee_hours is registered', !!batchTool, true);
  let roundTripOk = false;
  try { JSON.parse(JSON.stringify(tools)); roundTripOk = true; } catch (e) { roundTripOk = false; }
  check('the full tools array is valid, round-trippable JSON (not the failure cause)', roundTripOk, true);
  check('batch tool input_schema is a well-formed object schema', batchTool.input_schema.type, 'object');
  check('batch tool required list is present', batchTool.input_schema.required, ['entries']);
}

// ---- Extract processVoiceCommandLocal verbatim and exercise it ----
const startMarker = 'function _claireOfflineClientResult(lower, text, apiErrorReason) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find processVoiceCommandLocal with the new apiErrorReason param -- fix may have been reverted.'); process.exit(1); }
const endIdx = src.indexOf('\nfunction cancelVoiceCmd() {', startIdx + startMarker.length);
if (endIdx === -1) { console.error('FAIL: could not find end boundary after processVoiceCommandLocal'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx);

// Claire gate-bypass fix: every keyword-recognized branch (schedule/
// cancel/day-off/remind) now routes through the SAME approval gate PR
// #219 added, instead of writing directly -- see
// tests/claire-gate-bypass-fix.test.js for the full bug report and
// dedicated coverage. This file's own "remind" case (below) is updated
// to match: a recognized command now creates a proposal, not an
// immediate manualTasks write, so the gate module is pulled in too.
function extract(startMarker2, endMarker2) {
  const s = src.indexOf(startMarker2);
  const e = src.indexOf(endMarker2, s);
  return src.slice(s, e);
}
const gateSrc = extract(
  'var CLAIRE_TOOL_META = {',
  'async function processVoiceCommand(text) {'
) + '\n' + extract(
  'var _clairePendingProposals = []; // { id, html, sensitive }',
  '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom'
);

function makeFakeSupabase(tables) {
  function execQuery(state) {
    let rows = (tables[state.table] || []).slice();
    state.filters.forEach((f) => { rows = rows.filter((r) => r[f[0]] === f[1]); });
    if (state.op === 'insert') {
      const obj = Object.assign({}, state.payload);
      if (!obj.id) obj.id = 'id_' + Math.random().toString(36).slice(2);
      if (!('status' in obj)) obj.status = 'pending';
      if (!('risk' in obj)) obj.risk = 'normal';
      if (!('expires_at' in obj)) obj.expires_at = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      tables[state.table] = tables[state.table] || [];
      tables[state.table].push(obj);
      rows = [obj];
    }
    if (state.single) return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
    return { data: rows, error: null };
  }
  function builder(table) {
    const state = { table, filters: [], op: null, payload: null, single: false };
    const b = {
      insert: (o) => { state.op = 'insert'; state.payload = o; return b; },
      select: () => { if (!state.op) state.op = 'select'; return b; },
      eq: (k, v) => { state.filters.push([k, v]); return b; },
      single: () => { state.single = true; return Promise.resolve(execQuery(state)); },
      then: (resolve, reject) => Promise.resolve(execQuery(state)).then(resolve, reject),
    };
    return b;
  }
  return { from: (table) => builder(table) };
}

function buildSandbox() {
  const calls = [];
  // Claire-draft-and-fallback fix: the generic-fallback path no longer
  // calls claireReply at all -- it renders via _claireReplyWithRetry,
  // which goes straight to _claireRenderBubble. Captured separately so
  // the existing `calls` assertions (every KEYWORD-recognized path,
  // which still goes through claireReply) are unaffected.
  const bubbles = [];
  const tables = { claire_proposals: [] };
  const sandbox = {
    console,
    dateKey: function (d) { return '2026-09-17'; },
    parseScheduleCommand: function (lower, text) { return { error: 'no client found' }; },
    EMPLOYEE_ROSTER: [],
    window: { supabaseClient: makeFakeSupabase(tables), PentaTenant: { current: () => 'biz_1' } },
    manualTasks: [],
    saveManualTasks: function () {},
    renderTasks: function () {},
    claireReply: function (msg) { calls.push(msg); },
    _claireRenderBubble: function (who, html) { bubbles.push(html); },
    claireHideTyping: function () {},
    claireShowTyping: function () {},
    _claireSilent: false,
    getCurrentAppRole: function () { return 'owner'; },
    isManagerRole: function () { return true; },
    _pentaParseAuthToken: function () { return { user: { id: 'user_1' } }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(gateSrc + '\n' + fnSource, sandbox);
  return { sandbox: sandbox, calls: calls, bubbles: bubbles, tables: tables };
}

// ---- Claire-draft-and-fallback fix: the generic catch-all no longer
// recites the schedule/cancel template for a message that was never
// about scheduling or cancelling anything (Tom's exact bug report: a
// drafting request fell through to this branch and got "Try:
// Schedule [name]..." -- nonsensical for what he actually asked). It
// now shows an honest "couldn't reach my AI" message with a working
// Retry button, and the real failure reason goes to the visible
// last-error note (_claireSetLastErrorNote), not into the chat text. ----
async function runChecks() {
{
  const { sandbox, calls, bubbles } = buildSandbox();
  await sandbox.processVoiceCommandLocal('Set Maria hours to 9 to 5 on Tuesday', 'Anthropic error: invalid_request_error');
  check('no old-style claireReply call for the generic fallback', calls.length, 0);
  check('exactly one bubble rendered (the honest retry message)', bubbles.length, 1);
  check('the schedule/cancel template is gone -- never shown for a non-schedule message', /Schedule \[name\]/.test(bubbles[0]), false);
  check('the message is the plain, honest "couldn\'t reach my AI" text', /couldn.t reach my AI/i.test(bubbles[0]), true);
  check('a working Retry button is present, wired to resend the same message', /_claireRetryFailedMessage\(\)/.test(bubbles[0]), true);
}

// ---- No reason supplied (apiErrorReason omitted): the SAME honest
// message still renders -- it never depended on a reason being given,
// unlike the old parenthetical-suffix design. ----
{
  const { sandbox, calls, bubbles } = buildSandbox();
  await sandbox.processVoiceCommandLocal('asdkjfh nonsense gibberish');
  check('no old-style claireReply call for the generic fallback', calls.length, 0);
  check('exactly one bubble rendered', bubbles.length, 1);
  check('the same honest message renders with no reason supplied either', /couldn.t reach my AI/i.test(bubbles[0]), true);
}

// ---- Every existing keyword-recognized path is completely unaffected by
// the apiErrorReason param -- it must never leak into a WORKING local
// command's reply. Gate-bypass fix: "working" no longer means an
// immediate write -- it means a proposal is created (same as every
// other gated write), so this now asserts THAT instead of a direct
// manualTasks write. ----
{
  const { sandbox, calls, tables } = buildSandbox();
  await sandbox.processVoiceCommandLocal('remind me to call the supplier', 'some stale error that should never show here');
  check('a recognized "remind" command replies normally', calls.length, 1);
  check('the reminder confirmation does not mention the error reason', calls[0].indexOf('stale error') === -1, true);
  check('the reminder creates a proposal, not an immediate write (gate-bypass fix)', tables.claire_proposals.length, 1);
  check('nothing is written to manualTasks before Approve', sandbox.manualTasks.length, 0);
}
}

// ---- Verify the call sites thread the error through _claireUserFacingError
// (a short plain-English translation), not the raw .message -- and that the
// full technical detail is still logged (console + audit_log) before that
// translation happens, so a real regression stays diagnosable even though
// the operator no longer sees the raw text. ----
{
  const callSiteIdx = src.indexOf('if (!didAnyToolCall) { processVoiceCommandLocal(text, _claireUserFacingError(claireErr)); return; }');
  check('the round-0 API failure call site passes a translated (not raw) error through', callSiteIdx !== -1, true);
  const roundLogIdx = src.indexOf("_claireLogTechnicalError('processVoiceCommand round ' + round, claireErr);");
  check('the round-0 failure logs the full technical error before translating it', roundLogIdx !== -1, true);
  const outerCatchIdx = src.indexOf("console.error('[claire] processVoiceCommand failed:', e && e.message, e);");
  check('the previously-silent outer catch now logs the real error', outerCatchIdx !== -1, true);
  const outerLogIdx = src.indexOf("_claireLogTechnicalError('processVoiceCommand outer catch', e);");
  check('the outer catch also logs the full technical error to audit_log', outerLogIdx !== -1, true);
  const outerCallIdx = src.indexOf('processVoiceCommandLocal(text, _claireUserFacingError(e));');
  check('the outer catch threads a translated (not raw) error through to the fallback message', outerCallIdx !== -1, true);
}

runChecks().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
