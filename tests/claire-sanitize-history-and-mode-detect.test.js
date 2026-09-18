// Bug report (Sept 2026, recurrence): the exact same "unexpected
// tool_use_id found in tool_result blocks" 400 came back after the prior
// fix (_claireTrimHistory, tests/claire-history-trim-tool-pairing.test.js)
// shipped -- this time in a conversation short enough (2-3 messages) that
// trimming (cap 40) never even engaged. Reproduction from Tom:
//   1. Tom sends an 8-date batch hours message for team S1 without naming
//      an employee ("S1 9/8-934-637 10lunch 9/9-906-610. 10 lunch ...").
//   2. Claire opens with "Research mode -- pulling data and market
//      context..." (wrong -- this is a payroll edit, not a research
//      question) then asks "which employee - Nadia, Fatima, Franchesca,
//      or Natalia?"
//   3. Tom replies "yes" (not a valid answer to a 4-way named choice).
//   4. Claire crashes with the tool_use_id 400.
//
// Three separate, independently-reproducible bugs, fixed together:
//
// 1. _claireHistory is a single global array that persists for an entire
//    session (many unrelated messages, not just one conversation) --
//    _claireTrimHistory prevents NEW corruption at write time, but can't
//    undo corruption already sitting in the array from earlier in the
//    session. _claireSanitizeHistoryForApi() is a last-line-of-defense
//    guarantee, run immediately before every request: it advances past
//    any unsafe leading messages (same rule as the trim) AND walks the
//    rest of the array dropping any tool_use/tool_result pair that isn't
//    perfectly matched, so the array actually SENT can never violate
//    Anthropic's pairing rule, regardless of how corruption got in.
//
// 2. _detectClaireMode()'s length>120 fallback routed Tom's date-dense
//    batch message into research mode purely because it's long, not
//    because it reads like a research question -- wrong tone ("Research
//    mode...") and wrong system prompt/token budget for an operational
//    edit. Fixed with a date-token count check that wins over the length
//    fallback.
//
// 3. (Ambiguous "yes" handling is a system-prompt change, not testable
//    without a live model call -- verified by reading the prompt text
//    directly; see the system-prompt string in index.html around
//    "4a. If ' + _opName + ' gives you dates/times for a TEAM".)
//
// Run with: node tests/claire-sanitize-history-and-mode-detect.test.js

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

// ==== _claireSanitizeHistoryForApi ====
const sanitizeSrc = extract(
  'function _claireSanitizeHistoryForApi() {',
  '\n// Bug fix (same report): Claire\'s error paths'
);

function runSanitize(history) {
  const sandbox = { _claireHistory: history.slice() };
  vm.createContext(sandbox);
  vm.runInContext(sanitizeSrc + '\n_claireSanitizeHistoryForApi();', sandbox);
  return sandbox._claireHistory;
}

function everyToolResultHasAdjacentToolUse(history) {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'user' && Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result') {
      const prev = history[i - 1];
      const prevIds = (prev && prev.role === 'assistant' && Array.isArray(prev.content))
        ? prev.content.filter(b => b.type === 'tool_use').map(b => b.id) : [];
      for (const b of m.content) {
        if (b.type === 'tool_result' && prevIds.indexOf(b.tool_use_id) === -1) return false;
      }
    }
  }
  return true;
}
function everyToolUseHasAdjacentToolResult(history) {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const useIds = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
      if (!useIds.length) continue;
      const next = history[i + 1];
      const nextIds = (next && next.role === 'user' && Array.isArray(next.content))
        ? next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : [];
      for (const id of useIds) if (nextIds.indexOf(id) === -1) return false;
    }
  }
  return true;
}

// The exact reported shape: a short (well under any trim cap) history
// containing ALREADY-CORRUPTED entries dropped in from "earlier in the
// session" -- an orphaned tool_result with no preceding tool_use, exactly
// as if a bad trim (or any other bug) had left one sitting there.
{
  const preExistingCorruption = [
    { role: 'user', content: 'earlier unrelated message' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'stray' }] }, // orphan: no preceding tool_use
    { role: 'assistant', content: [{ type: 'text', text: 'which employee - Nadia, Fatima, Franchesca, or Natalia?' }] },
    { role: 'user', content: 'yes' },
  ];
  const cleaned = runSanitize(preExistingCorruption);
  check('a short history (well under any trim cap) with a pre-existing orphaned tool_result is still cleaned', everyToolResultHasAdjacentToolUse(cleaned));
  check('the operator\'s actual messages survive sanitization', cleaned.some(m => m.role === 'user' && m.content === 'yes'));
}

// A fully valid short history is left untouched (no false positives).
{
  const valid = [
    { role: 'user', content: 'set S1 hours' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'batch_edit_employee_hours', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'preview' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'which employee?' }] },
  ];
  const cleaned = runSanitize(valid);
  check('a fully valid short history is returned unchanged', JSON.stringify(cleaned) === JSON.stringify(valid));
}

// A broken pair (mismatched ids) drops BOTH sides, not just one -- a
// half-fix just trades one 400 ("unexpected tool_use_id") for the other
// ("tool_use ids without tool_result").
{
  const brokenPair = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_WRONG', content: 'oops' }] },
    { role: 'user', content: 'next real turn' },
  ];
  const cleaned = runSanitize(brokenPair);
  check('a mismatched tool_use/tool_result pair is dropped entirely (both sides)', everyToolResultHasAdjacentToolUse(cleaned) && everyToolUseHasAdjacentToolResult(cleaned));
  check('unrelated plain-text turns around the broken pair survive', cleaned.some(m => m.content === 'go') && cleaned.some(m => m.content === 'next real turn'));
}

// ==== _claireUserFacingError ====
const errSrc = extract(
  'function _claireUserFacingError(err) {',
  '\n\n// Best-effort durable log'
);
function translate(err) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(errSrc + '\nvar __r = _claireUserFacingError(' + JSON.stringify(err) + ');', sandbox);
  return sandbox.__r;
}

const rawToolUseIdError = { message: 'claire-chat EF non-2xx — {"error":"upstream_error","detail":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"messages.0.content.0: unexpected tool_use_id found in tool_result blocks: toolu_0145LATfBzWcwGXppAp4XtWr. Each tool_result block must have a corresponding tool_use block in the previous message.\\"}}\\" (Anthropic status: 400)' };
const translated = translate(rawToolUseIdError);
check('a raw Anthropic 400/JSON error is translated to a short plain sentence', translated.length < 80 && !/\{|"type"|Anthropic status/.test(translated));
check('the translated tool_use_id message reads as an actionable retry prompt', /resend|try again/i.test(translated));

const genericErr = { message: 'HTTP 502' };
check('an unrecognized technical error still gets a short generic fallback, never raw text', translate(genericErr) === 'Something went wrong. Try again?');

const netErr = { message: 'claire-chat: network TypeError: Failed to fetch' };
check('a network error is translated plainly', /connection/i.test(translate(netErr)));

const sessionErr = { message: 'claire-chat: no active session (sign in again)' };
check('a session/auth error tells the operator to sign back in, not the raw message', /sign/i.test(translate(sessionErr)));

// ==== _detectClaireMode ====
const modeSrc = extract(
  'function _detectClaireMode(text) {',
  '\n\nfunction _claireShowResearchLabel'
);
function detectMode(text) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(modeSrc + '\nvar __r = _detectClaireMode(' + JSON.stringify(text) + ');', sandbox);
  return sandbox.__r;
}

const tomsBatchMessage = "S1 9/8-934-637 10lunch 9/9-906-610. 10 lunch 9/10 910-722 10lunch 9/11 918-351 10lunch 9/14 916-739 15lunch 9/15 921-611 15lunch 9/16 917-631 10lunch 9/17 923-531 10lunch";
check('Tom\'s exact 8-date reproduction message is well over the old 120-char research threshold (proves this exercises the fix, not a no-op)', tomsBatchMessage.length > 120);
check('Tom\'s exact 8-date batch message stays in voice mode, not research', detectMode(tomsBatchMessage) === 'voice');

check('a real research question well over 120 chars still routes to research mode (no regression)', detectMode('How does our pricing strategy compare to competitors in the area, and what should our growth plan look like for next year given current market trends?') === 'research');
check('a single-date short operational message still stays voice (no regression)', detectMode('set Maria Tuesday 9/2 to 9-5') === 'voice');
check('a plain short message with no dates stays voice (no regression)', detectMode('is Nadia off today') === 'voice');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
