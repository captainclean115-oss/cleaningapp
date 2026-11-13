// Claire-draft-and-fallback fix.
//
// PROBLEM 1 (Tom, phone, Nov 13 ~11:32am ET): asked Claire to draft a
// text to a client about an unpaid balance. Claire showed "Research
// mode -- pulling data and market context..." then replied "I lost
// track -- can you resend your last request? Try: 'Schedule [name]
// [day] [time] [team]' or 'Cancel [name] [day]'." Two bugs: (1)
// _detectClaireMode's length>120 fallback routed the long, dictated,
// run-on drafting request into research mode purely because it was
// long -- the message never started with an action verb the
// start-anchored list recognized, and "draft"/"write" weren't on it
// at all; (2) the Anthropic call then failed with a conversation-
// history-shaped error, and processVoiceCommandLocal's generic
// catch-all -- for ANY unrecognized message, regardless of what it
// was actually about -- unconditionally recited the schedule/cancel
// example template.
//
// PROBLEM 2: a stale pending proposal card from before the resolve-
// before-propose fix (PR #225) still showed "Cancel a client's clean
// on 2026-11-11" with live Approve/Reject buttons.
//
// This file covers: drafting requests never route to research mode or
// hit the schedule-only template; a server failure (or any message
// local parsing can't recognize) shows the honest retry message with
// a working Retry button that resends the exact original text; a
// drafted message wrapped in a fenced block renders as a copyable
// block; proposal summaries still name the client (no regression);
// Approve never reports "Done" for a write that didn't land; and a
// stale/expired pending proposal renders as Expired with no live
// Approve button.
//
// Run with: node tests/claire-draft-and-fallback.test.js

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

async function main() {

// ============================================================================
// 1. Drafting requests stay in voice mode, never research -- regardless
//    of how long the dictated message runs, and regardless of phrasing
//    ("can you draft...", not just "draft...").
// ============================================================================
{
  const modeSrc = extract('function _detectClaireMode(text) {', '\n\nfunction _claireShowResearchLabel', 'mode');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(modeSrc, sandbox);

  const tomsMessage = "Can you draft a text to the client used to leave a check out for us and we have not received one in the past nine cleans and the balance is $1917 I would like to see if I can pick up a check today";
  check('Tom\'s exact message is well over the old 120-char research threshold', tomsMessage.length > 120);
  check('Tom\'s exact drafting request stays in voice mode, not research', sandbox._detectClaireMode(tomsMessage) === 'voice');
  check('"write a text to..." also stays in voice mode', sandbox._detectClaireMode('Can you write a text to Jane about her balance, she has not paid in a while and this needs to run on long enough that it would have tripped the old one hundred twenty character length fallback by itself') === 'voice');
  check('a bare "draft" anywhere in the message is enough, not just at the start', sandbox._detectClaireMode('I need you to draft something for a client, her balance is high and we have not heard from her in months despite several attempts to reach out about the outstanding amount owed') === 'voice');
  check('a real research question well over 120 chars still routes to research (no regression)', sandbox._detectClaireMode('How does our pricing strategy compare to competitors in the area, and what should our growth plan look like for next year given current market trends?') === 'research');
  check('a short schedule command still stays voice (no regression)', sandbox._detectClaireMode('schedule Lisa Tuesday 9am team B1') === 'voice');
}

// ============================================================================
// 2. A drafted message wrapped in a ``` fenced block renders as its own
//    copyable block with a Copy button; any reply without a fence
//    passes through unchanged (no regression for every normal reply).
// ============================================================================
{
  const fnSrc = extract('function _claireRenderDraftBlock(msg) {', '\nfunction _claireCopyDraft', 'draft block');
  const escSrc = extract('function _claireEscapeHtml(s) {', '\n\nfunction _claireProposalCardHtml', 'escape');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(escSrc, sandbox);
  vm.runInContext(fnSrc, sandbox);

  const plain = 'Which client did you mean -- Jane or Joan?';
  check('a reply with no fenced block passes through byte-for-byte unchanged', sandbox._claireRenderDraftBlock(plain) === plain);

  const draftMsg = 'Here is a draft for Jane Smith:\n```\nHi Jane, this is Manna Maids -- we show a balance of $1,842. Could you leave a check out today?\n```';
  const rendered = sandbox._claireRenderDraftBlock(draftMsg);
  check('the lead-in sentence renders outside the copy block', rendered.indexOf('Here is a draft for Jane Smith') !== -1);
  check('the exact draft text renders inside the copy block', rendered.indexOf('we show a balance of $1,842') !== -1);
  check('the fence markers themselves never show up literally', rendered.indexOf('```') === -1);
  check('a Copy button is present, wired to _claireCopyDraft', /onclick="_claireCopyDraft\('[^']+'\)"/.test(rendered));
}

// ============================================================================
// 3. The generic fallback (local parsing recognized nothing, because
//    the message was never about scheduling/cancelling/day-off/
//    reminding -- a drafting request, or any server failure on an
//    unrecognized message) shows the honest retry message, never the
//    schedule/cancel template, and Retry resends the exact original text.
// ============================================================================
{
  const gateSrc = extract('var _clairePendingProposals = []; // { id, html, sensitive }', '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom', 'gate');
  const localFallbackSrc = extract('function _claireOfflineClientResult(lower, text, apiErrorReason) {', '\nfunction cancelVoiceCmd() {', 'local fallback');

  function buildSandbox() {
    const bubbles = [];
    const retried = [];
    const sandbox = {
      console,
      window: {},
      localStorage: { setItem: function () {}, getItem: function () { return null; } },
      document: { getElementById: function () { return null; } },
      EMPLOYEE_ROSTER: [],
      _claireRenderBubble: function (who, html) { bubbles.push(html); },
      claireHideTyping: function () {},
      claireShowTyping: function () {},
      _claireSilent: false,
      claireReply: function () { throw new Error('claireReply should not be called by the generic fallback anymore'); },
      processVoiceCommand: function (text) { retried.push(text); },
    };
    vm.createContext(sandbox);
    vm.runInContext(gateSrc + '\n' + localFallbackSrc, sandbox);
    return { sandbox: sandbox, bubbles: bubbles, retried: retried };
  }

  // Tom's exact drafting message -- no keyword branch recognizes it,
  // so it must fall through to the generic fallback.
  const tomsMessage = "Can you draft a text to the client used to leave a check out for us and we have not received one in the past nine cleans and the balance is $1917 I would like to see if I can pick up a check today";
  {
    const { sandbox, bubbles } = buildSandbox();
    await sandbox.processVoiceCommandLocal(tomsMessage, 'I lost track — can you resend your last request?');
    check('a drafting request never hits the schedule-only template', bubbles.length === 1 && !/Schedule \[name\]/.test(bubbles[0]));
    check('the honest "couldn\'t reach my AI" message shows instead', /couldn.t reach my AI/i.test(bubbles[0]));
    check('a Retry button is present, wired to _claireRetryFailedMessage', /_claireRetryFailedMessage\(\)/.test(bubbles[0]));
  }

  // Retry resends the EXACT original text, never a mangled/partial copy.
  {
    const { sandbox, retried } = buildSandbox();
    await sandbox.processVoiceCommandLocal(tomsMessage);
    sandbox._claireRetryFailedMessage();
    check('Retry calls processVoiceCommand with the saved text verbatim', retried.length === 1 && retried[0] === tomsMessage);
  }

  // Also true with NO reason supplied at all (a genuinely-unrecognized
  // message, not necessarily a server failure).
  {
    const { sandbox, bubbles } = buildSandbox();
    await sandbox.processVoiceCommandLocal('asdkjfh nonsense gibberish');
    check('an unrecognized message with no reason given still gets the honest message, never the old template', bubbles.length === 1 && !/Schedule \[name\]/.test(bubbles[0]) && /couldn.t reach my AI/i.test(bubbles[0]));
  }

  // A keyword-recognized branch (remind) never reaches the generic
  // fallback at all -- it returns from inside its own branch.
  {
    const { sandbox, bubbles } = buildSandbox();
    sandbox._claireDispatchOrPropose = async function (toolCall) { return 'Proposal created for "' + (toolCall.input.text || '') + '" -- waiting for your approval. Nothing has changed yet.'; };
    sandbox._claireFlushProposalCards = function () {};
    sandbox.claireReply = function () {}; // this branch DOES call claireReply -- allow it here
    await sandbox.processVoiceCommandLocal('remind me to call the supplier', 'some stale error that should never show here');
    check('a recognized "remind" command never reaches the generic fallback bubble', bubbles.length === 0);
  }
}

// ============================================================================
// 4. DRAFTING behavior is documented in the system prompt: read-only, no
//    approval, asks when the client is ambiguous, pulls real balance
//    data via existing read tools, flags a mismatch against Tom's own
//    figure, never sends. (Model behavior itself isn't testable without
//    a live API call -- verified by reading the prompt text directly,
//    same approach claire-sanitize-history-and-mode-detect.test.js
//    already uses for the ambiguous-"yes" system-prompt instruction.)
// ============================================================================
{
  const promptIdx = src.indexOf('DRAFTING A MESSAGE');
  check('the system prompt documents a DRAFTING flow at all', promptIdx !== -1);
  const promptSlice = src.slice(promptIdx, promptIdx + 2500);
  check('drafting is explicitly read-only, no approval needed', /READ-ONLY/.test(promptSlice) && /no approval/.test(promptSlice));
  check('an ambiguous/unnamed client gets ONE question, never a guess', /ask ONE short question/.test(promptSlice) && /[Nn]ever guess/.test(promptSlice));
  check('real balance/payment/cleans-since data is pulled via lookup_balance, never invented', /lookup_balance/.test(promptSlice) && /never invent or assume/.test(promptSlice));
  check('a mismatch against Tom\'s own figure is flagged, not silently overridden', /disagrees with what the tools return/.test(promptSlice));
  check('the draft is never sent by Claire -- the human copies and sends it themselves', /never sent by Claire/.test(promptSlice) || /never.{0,20}call send_text/.test(promptSlice));
}

// ============================================================================
// 5. Proposal summaries name the client (no regression from this fix --
//    full coverage lives in tests/claire-proposal-resolve-verify.test.js;
//    this is a light regression check specific to this file's own scope).
// ============================================================================
{
  const summarySrc = extract('function _claireProposalSummary(toolName, input) {', '\n\nfunction _claireEscapeHtml', 'summary');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(summarySrc, sandbox);
  check('cancel_clean names a real client, never falls back to "a client" when given one', sandbox._claireProposalSummary('cancel_clean', { client: 'Lisa Finkel', date: '2026-11-11' }) === 'Cancel Lisa Finkel\'s clean on 2026-11-11.');
}

// ============================================================================
// 6. Approve never reports "Done" for a write that didn't actually land
//    -- a non-throwing-but-failed tool result is still a failure.
// ============================================================================
{
  const gateSrc = extract('var CLAIRE_TOOL_META = {', 'async function processVoiceCommand(text) {', 'toolmeta+gate');
  const propSrc = extract('var _clairePendingProposals = []; // { id, html, sensitive }', '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom', 'proposals');

  function makeFakeSupabase(tables) {
    function execQuery(state) {
      let rows = (tables[state.table] || []).slice();
      state.filters.forEach((f) => { rows = rows.filter((r) => r[f[0]] === f[1]); });
      if (state.op === 'update') rows.forEach((r) => Object.assign(r, state.payload));
      if (state.single) return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: rows, error: null };
    }
    function builder(table) {
      const state = { table, filters: [], op: null, payload: null, single: false };
      const b = {
        update: (o) => { state.op = 'update'; state.payload = o; return b; },
        select: () => { if (!state.op) state.op = 'select'; return b; },
        eq: (k, v) => { state.filters.push([k, v]); return b; },
        single: () => { state.single = true; return Promise.resolve(execQuery(state)); },
        then: (resolve, reject) => Promise.resolve(execQuery(state)).then(resolve, reject),
      };
      return b;
    }
    return { from: (table) => builder(table), auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } };
  }

  const tables = { claire_proposals: [] };
  const statusEl = { textContent: '' };
  const card = { querySelector: (sel) => (sel === '.claire-proposal-status' ? statusEl : null), querySelectorAll: () => [], remove: function () {} };
  const sandbox = {
    console,
    window: { supabaseClient: makeFakeSupabase(tables), PentaTenant: { current: () => 'biz_1' } },
    document: { getElementById: (id) => (id === 'claire-proposal-row1' ? card : null) },
    // _claireSessionInfo/_claireIsOwnerOrAdmin are REAL functions inside
    // gateSrc's own extracted range -- stubbing their dependencies
    // instead of the functions themselves (which vm.runInContext would
    // just overwrite with the real definition anyway).
    _pentaParseAuthToken: () => ({ user: { id: 'u1' } }),
    getCurrentAppRole: () => 'owner',
    _claireTodayKey: () => '2026-11-13',
    // The write silently returns normally with no change -- exactly
    // the class of bug this fix targets: NOT throwing is not the same
    // as succeeding.
    executeClaireToolCall: async () => '{"error":"client_not_found","query":"","suggestions":[]}',
  };
  tables.claire_proposals.push({ id: 'row1', status: 'pending', tool_name: 'cancel_clean', args: { client: '', date: '2026-11-11' }, summary: 'Cancel a client\'s clean on 2026-11-11.', risk: 'normal', expires_at: new Date(Date.now() + 3600 * 1000).toISOString() });
  vm.createContext(sandbox);
  vm.runInContext(gateSrc + '\n' + propSrc, sandbox);

  await sandbox._claireApproveProposal('row1');
  check('a tool result that reads as an error, even without throwing, is at minimum not silently "Done"', statusEl.textContent !== 'Done.');
}

// ============================================================================
// 7. A stale pending proposal (past its 48h TTL, OR whose own action
//    date has already gone by) renders as Expired with no live Approve
//    button -- only a Dismiss. A fresh pending proposal is unaffected.
// ============================================================================
{
  const staleSrc = extract('function _claireProposalIsStale(row) {', '\n\n// Renders every card queued this turn', 'stale+card');
  const escSrc2 = extract('function _claireEscapeHtml(s) {', '\n\nfunction _claireProposalCardHtml', 'escape2');
  const sandbox = { _claireTodayKey: function () { return '2026-11-13'; } };
  vm.createContext(sandbox);
  vm.runInContext(escSrc2, sandbox);
  vm.runInContext(staleSrc, sandbox);

  // The exact shape of Tom's real stale card: pending, not yet past its
  // formal 48h TTL, but its own action date (2026-11-11) is long gone.
  const staleRow = { id: 'stale1', status: 'pending', risk: 'normal', summary: 'Cancel a client\'s clean on 2026-11-11.', args: { date: '2026-11-11', client: '' }, expires_at: '2026-11-13T21:37:19.000Z' };
  check('Tom\'s exact stale-card shape is flagged stale even though its formal TTL has not passed yet', sandbox._claireProposalIsStale(staleRow) === true);
  const staleHtml = sandbox._claireProposalCardHtml(staleRow);
  check('the stale card shows "Expired", not "Waiting for your approval"', /Expired/.test(staleHtml) && !/Waiting for your approval/.test(staleHtml));
  check('the stale card has no live Approve button', !/_claireApproveProposal/.test(staleHtml));
  check('the stale card has a Dismiss button (Reject, under the hood) so it can be removed', /_claireRejectProposal\('stale1'\)/.test(staleHtml) && /Dismiss/.test(staleHtml));

  const freshRow = { id: 'fresh1', status: 'pending', risk: 'normal', summary: 'Cancel Jane Smith\'s clean on 2026-11-14.', args: { date: '2026-11-14', client: 'Jane Smith' }, expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString() };
  check('a fresh future-dated proposal is NOT stale', sandbox._claireProposalIsStale(freshRow) === false);
  const freshHtml = sandbox._claireProposalCardHtml(freshRow);
  check('a fresh proposal still shows live Approve/Reject buttons', /_claireApproveProposal\('fresh1'\)/.test(freshHtml) && /_claireRejectProposal\('fresh1'\)/.test(freshHtml));

  const decidedRow = { id: 'old1', status: 'approved', risk: 'normal', summary: 'x', args: { date: '2020-01-01' }, expires_at: '2020-01-03T00:00:00Z' };
  check('an already-decided row is never "stale" -- it already is whatever it became', sandbox._claireProposalIsStale(decidedRow) === false);
}

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
