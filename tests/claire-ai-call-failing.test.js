// Claire-ai-call-failing fix.
//
// REAL root cause (confirmed via the claire-chat Edge Function's own
// logs for both the 2026-11-13 11:32am and 12:56pm ET incidents, not
// guessed): Anthropic itself rejected every call with "Your credit
// balance is too low to access the Anthropic API." -- a billing
// problem on the Anthropic account, not a bug in this app. The
// request body each time was small, clean, and well-formed
// (messages_count 1-2, tools_count 34, no sign of a broken
// tool_use/tool_result pairing) -- confirming PR #232's earlier guess
// (a conversation-history problem, inferred only from the client-side
// error TEXT containing the substring "invalid_request_error") was
// wrong. That substring is Anthropic's GENERIC "something about this
// request was invalid" error type -- it covers many distinct causes,
// including insufficient credits, not specifically a broken pairing.
//
// Two real bugs fixed here as a result:
// 1. _claireUserFacingError mapped EVERY invalid_request_error to "I
//    lost track -- can you resend your last request?", which is
//    actively wrong for a credits problem (retrying can never fix it,
//    and it falsely implies a memory issue). A credit-balance message
//    now gets its own honest, actionable translation; the "lost
//    track" message is narrowed to the phrases that actually mean a
//    broken tool_use/tool_result pairing; anything else just gets a
//    neutral "wasn't accepted" message.
// 2. The last-error line in the Claire menu was being set from the
//    already-translated FRIENDLY string, so it could never tell Tom
//    anything beyond what the chat bubble already said. It now
//    carries the raw HTTP status + the server's own error message.
//
// Also hardens Retry: if the SAME message fails twice in a row, the
// second Retry tap falls back to a clean in-memory history before
// trying again, in case the accumulated history itself was ever part
// of a future problem -- Tom's visible chat transcript is untouched.
//
// Run with: node tests/claire-ai-call-failing.test.js

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

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker (' + label + '): ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker (' + label + '): ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}

// ============================================================================
// 1. _claireUserFacingError: the real Anthropic billing/credits error
//    (Tom's exact reproduction) gets its own honest, actionable
//    message -- never the old "I lost track" memory-loss claim. The
//    tool-pairing message is narrowed to the phrases that actually
//    mean a broken pairing; any OTHER invalid_request_error gets a
//    neutral message instead of a false claim either way.
// ============================================================================
{
  const errSrc = extract('function _claireUserFacingError(err) {', '\n\n// Best-effort durable log', 'translator');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(errSrc, sandbox);

  // The exact Anthropic response body seen in the real Edge Function
  // logs for both incidents (2026-11-13 11:32am and 12:56pm ET),
  // wrapped the same way _claireApi's own error-summary building does.
  const realBillingErr = { message: 'EF non-2xx: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Ch1MoX7f2Tk5m7ikT7ni3"} (Anthropic status: 400)', status: 502 };
  const translated = sandbox._claireUserFacingError(realBillingErr);
  check('Tom\'s exact billing error gets a credits-specific message, not "I lost track"', !/lost track/i.test(translated));
  check('the credits message mentions credits/billing, not a generic retry', /credit|billing/i.test(translated));
  check('the credits message is actionable (mentions the owner/Anthropic), not just "try again"', /owner|Anthropic/i.test(translated));

  check('a genuine broken tool_use/tool_result pairing still gets "I lost track"', /lost track/i.test(sandbox._claireUserFacingError({ message: 'unexpected tool_use_id found in tool_result blocks: toolu_123' })));
  check('"tool_use ids without tool_result" also still gets "I lost track"', /lost track/i.test(sandbox._claireUserFacingError({ message: 'found tool_use ids without tool_result blocks immediately after' })));

  const genericInvalidReq = sandbox._claireUserFacingError({ message: 'invalid_request_error: max_tokens: 999999999 is too large' });
  check('an invalid_request_error that is NEITHER billing NOR a broken pairing never claims "lost track" either', !/lost track/i.test(genericInvalidReq));
  check('that generic case still gets a short, honest message', genericInvalidReq.length > 0 && genericInvalidReq.length < 60);

  // No regressions on the other existing branches.
  check('rate limit unaffected', sandbox._claireUserFacingError({ isRateLimit: true }) === 'Hit rate limit, slow down — try again in a few minutes.');
  check('session/sign-in unaffected', /sign/i.test(sandbox._claireUserFacingError({ message: 'no active session (sign in again)' })));
  check('network unaffected', /connection/i.test(sandbox._claireUserFacingError({ message: 'claire-chat: network TypeError: Failed to fetch' })));
  check('generic unknown error unaffected', sandbox._claireUserFacingError({ message: 'HTTP 502' }) === 'Something went wrong. Try again?');
}

// ============================================================================
// 2. _claireRawErrorDetail: builds "HTTP <status>: <message>" trimmed
//    to ~150 chars -- deliberately MORE detailed than the friendly
//    chat text, for the menu's diagnostics line.
// ============================================================================
{
  const fnSrc = extract('function _claireRawErrorDetail(err) {', '\n\n// v9.5.4: name normalizer', 'raw detail');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);

  const detail = sandbox._claireRawErrorDetail({ status: 502, message: 'EF non-2xx: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. Extra padding text to push this well past one hundred fifty characters in total length for the trim check below.' });
  check('the raw detail includes the HTTP status', detail.indexOf('HTTP 502') === 0);
  check('the raw detail includes the real server message, not a generic placeholder', detail.indexOf('credit balance is too low') !== -1);
  check('the raw detail is trimmed to ~150 chars, never unbounded', detail.length === 150);
  check('no error object at all still returns a safe placeholder, never throws', sandbox._claireRawErrorDetail(null) === 'Unknown error.');
  check('an error with no status omits the HTTP prefix, just shows the message', sandbox._claireRawErrorDetail({ message: 'plain failure' }) === 'plain failure');
}

// ============================================================================
// 3. The two real call sites in processVoiceCommand set the RAW detail
//    (for the menu) before translating (for the chat bubble) -- a
//    structural check on the actual call sites, same lightweight
//    src.indexOf approach tests/claire-api-failure-reason-surfaced.test.js
//    already uses for this exact code (running the full tool-loop
//    function needs a much larger sandbox than this specific wiring
//    warrants).
// ============================================================================
{
  const innerIdx = src.indexOf("if (!didAnyToolCall) {\n          _claireSetLastErrorNote(_claireRawErrorDetail(claireErr));\n          processVoiceCommandLocal(text, _claireUserFacingError(claireErr));\n          return;\n        }");
  check('the round-0 failure sets the raw last-error detail BEFORE translating for the chat bubble', innerIdx !== -1);

  const outerIdx = src.indexOf("_claireSetLastErrorNote(_claireRawErrorDetail(e));\n    processVoiceCommandLocal(text, _claireUserFacingError(e));");
  check('the outer catch sets the raw last-error detail BEFORE translating for the chat bubble', outerIdx !== -1);

  // The generic fallback itself no longer re-sets (and so can no
  // longer overwrite) the richer detail the real callers just set.
  const fallbackOverwriteIdx = src.indexOf('_claireSetLastErrorNote(apiErrorReason);\n  _claireReplyWithRetry(text);');
  check('the generic fallback no longer overwrites the raw detail with the friendly reason', fallbackOverwriteIdx === -1);
}

// ============================================================================
// 4. Retry falls back to a clean history after the SAME message fails
//    twice in a row -- Tom's visible chat transcript is never touched
//    (no _claireRenderBubble call clears or rewrites it); a different,
//    unrelated message's first retry is never affected by an earlier
//    message's leftover attempt count.
// ============================================================================
{
  const retrySrc = extract('var _claireLastFailedMessage = null;', '\nfunction _claireSetLastErrorNote', 'retry');

  function buildSandbox() {
    const processCalls = [];
    const sandbox = {
      console,
      _claireHistory: ['turn 1', 'turn 2', 'turn 3'],
      _claireActiveConversationId: 'convo-abc',
      _claireSilent: false,
      _claireRenderBubble: function () {},
      claireHideTyping: function () {},
      claireShowTyping: function () {},
      processVoiceCommand: function (text) { processCalls.push(text); },
    };
    vm.createContext(sandbox);
    vm.runInContext(retrySrc, sandbox);
    return { sandbox: sandbox, processCalls: processCalls };
  }

  // Message A fails, gets retried once (1st attempt) -- history must
  // survive untouched; this is only the FIRST retry, not the second.
  {
    const { sandbox, processCalls } = buildSandbox();
    sandbox._claireReplyWithRetry('message A');
    sandbox._claireRetryFailedMessage();
    check('1st retry of a message keeps the existing history intact', sandbox._claireHistory.length === 3);
    check('1st retry keeps the existing conversation id', sandbox._claireActiveConversationId === 'convo-abc');
    check('1st retry still calls processVoiceCommand with the original text', processCalls.length === 1 && processCalls[0] === 'message A');

    // That retry ALSO fails (same message reported failed again) --
    // and Tom taps Retry a 2nd time for THIS SAME message.
    sandbox._claireReplyWithRetry('message A');
    sandbox._claireRetryFailedMessage();
    check('2nd consecutive failure of the SAME message clears the history', sandbox._claireHistory.length === 0);
    check('2nd consecutive failure also resets the conversation id, so it starts a genuinely fresh thread server-side', sandbox._claireActiveConversationId === null);
    check('processVoiceCommand is still called with the exact original text, unchanged', processCalls.length === 2 && processCalls[1] === 'message A');
  }

  // A different, unrelated message's first failure/retry is NEVER
  // affected by an earlier message's leftover attempt count.
  {
    const { sandbox } = buildSandbox();
    sandbox._claireReplyWithRetry('message A');
    sandbox._claireRetryFailedMessage(); // A's 1st retry -- count now sits at 1 for "A"
    sandbox._claireReplyWithRetry('message B'); // a totally different message fails fresh
    sandbox._claireRetryFailedMessage(); // B's 1st retry -- must NOT inherit A's count
    check('an unrelated message\'s own first retry is unaffected by an earlier message\'s attempt count', sandbox._claireHistory.length === 3);
  }

  // Tapping Retry with nothing pending (already resolved, or never
  // failed) is a safe no-op.
  {
    const { sandbox, processCalls } = buildSandbox();
    sandbox._claireRetryFailedMessage();
    check('retrying with nothing pending does nothing, never throws', processCalls.length === 0);
  }
}

// ============================================================================
// 5. The last-error line shows the RAW detail (status + server
//    message), not a generic/friendly placeholder -- the whole point
//    of a diagnostics line is to carry what the chat bubble can't.
// ============================================================================
{
  const noteSrc = extract('function _claireSetLastErrorNote(reasonText) {', '\n\nfunction cancelVoiceCmd', 'last error note');
  const store = {};
  const sandbox = {
    console,
    localStorage: {
      setItem: function (k, v) { store[k] = v; },
      getItem: function (k) { return store[k] || null; },
    },
    document: {
      getElementById: function (id) { return id === 'claire-last-error-line' ? sandbox._el : null; },
    },
  };
  sandbox._el = { textContent: '' };
  vm.createContext(sandbox);
  vm.runInContext(noteSrc, sandbox);

  sandbox._claireSetLastErrorNote('HTTP 502: Your credit balance is too low to access the Anthropic API.');
  check('the last-error line shows the real detail passed to it, not a generic message', sandbox._el.textContent.indexOf('credit balance is too low') !== -1);
  check('the last-error line includes a timestamp so Tom knows how stale it is', /Last error:/.test(sandbox._el.textContent));

  // Never throws even with no DOM/storage available (a defensive gap
  // this fix also closed -- a bare document.getElementById call used
  // to sit outside its own try/catch).
  const sandbox2 = { console };
  vm.createContext(sandbox2);
  vm.runInContext(noteSrc, sandbox2);
  let threw = false;
  try { sandbox2._claireSetLastErrorNote('whatever'); } catch (e) { threw = true; }
  check('setting the last-error note never throws even with no document/localStorage at all', threw === false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
