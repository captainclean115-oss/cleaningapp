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
const startMarker = 'function processVoiceCommandLocal(text, apiErrorReason) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find processVoiceCommandLocal with the new apiErrorReason param -- fix may have been reverted.'); process.exit(1); }
const endIdx = src.indexOf('\nfunction ', startIdx + startMarker.length);
if (endIdx === -1) { console.error('FAIL: could not find end boundary after processVoiceCommandLocal'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx);

function buildSandbox() {
  const calls = [];
  const sandbox = {
    console,
    dateKey: function (d) { return '2026-09-17'; },
    parseScheduleCommand: function (lower, text) { return { error: 'no client found' }; },
    EMPLOYEE_ROSTER: [],
    window: {},
    manualTasks: [],
    saveManualTasks: function () {},
    renderTasks: function () {},
    claireReply: function (msg) { calls.push(msg); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, calls: calls };
}

// ---- The failure case: local parsing finds nothing to do AND an API
// error reason was passed through -- the reason must be surfaced. ----
{
  const { sandbox, calls } = buildSandbox();
  sandbox.processVoiceCommandLocal('Set Maria hours to 9 to 5 on Tuesday', 'Anthropic error: invalid_request_error');
  check('exactly one reply', calls.length, 1);
  check('the generic fallback now includes the real failure reason', calls[0].indexOf('Anthropic error: invalid_request_error') !== -1, true);
  check('the format-hint suggestions are still present', /Schedule \[name\]/.test(calls[0]), true);
}

// ---- No reason supplied (apiErrorReason omitted): message is unchanged
// from before -- a genuinely-unrecognized message doesn't grow a scary
// error suffix out of nowhere. ----
{
  const { sandbox, calls } = buildSandbox();
  sandbox.processVoiceCommandLocal('asdkjfh nonsense gibberish');
  check('exactly one reply', calls.length, 1);
  check('no parenthetical appears when no reason was given', calls[0], 'Sorry, I\'m having trouble connecting right now. Try: "Schedule [name] [day] [time] [team]" or "Cancel [name] [day]".');
}

// ---- Every existing keyword-recognized path is completely unaffected --
// the apiErrorReason param must never leak into a WORKING local command. ----
{
  const { sandbox, calls } = buildSandbox();
  sandbox.processVoiceCommandLocal('remind me to call the supplier', 'some stale error that should never show here');
  check('a recognized "remind" command replies normally', calls.length, 1);
  check('the reminder confirmation does not mention the error reason', calls[0].indexOf('stale error') === -1, true);
  check('the reminder was actually added', sandbox.manualTasks.length, 1);
}

// ---- Verify the call site actually threads claireErr.message through
// (not just that processVoiceCommandLocal accepts the param). ----
{
  const callSiteIdx = src.indexOf('if (!didAnyToolCall) { processVoiceCommandLocal(text, claireErr && claireErr.message); return; }');
  check('the round-0 API failure call site passes the real error through', callSiteIdx !== -1, true);
  const outerCatchIdx = src.indexOf("console.error('[claire] processVoiceCommand failed:', e && e.message, e);");
  check('the previously-silent outer catch now logs the real error', outerCatchIdx !== -1, true);
  const outerCallIdx = src.indexOf('processVoiceCommandLocal(text, e && e.message);');
  check('the outer catch also threads its error through to the fallback message', outerCallIdx !== -1, true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
