// Claire auth-refresh fix.
//
// Bug report: Tom (owner/admin, app otherwise working) typed "Cancel
// Lisa today" and got "Couldn't find that job to cancel." -- then
// "Lisa Finkel" got "You got signed out - sign back in and try again."
// Diagnosis (confirmed via the project's own Auth/Edge Function logs,
// read-only): _claireApi grabbed the access token via a single
// sb.auth.getSession() call with ZERO retry logic; when that came back
// empty (a backgrounded iOS tab/PWA can suspend the SDK's own
// background refresh timer long enough for the cached session to go
// stale), it threw "no active session" immediately -- confirmed: ZERO
// requests ever reached /functions/v1/claire-chat in the entire prior
// 24h, so the failure never even reached the network/EF stage.
// Separately, parseScheduleCommand (the offline fallback's crude
// client matcher) had no branch for a bare first name at all --
// "Cancel Lisa today" never matched anything, producing the false
// "couldn't find that job" diagnosis when the real problem was the
// dead connection.
//
// This file extracts the REAL _claireGetSessionToken/_claireApi,
// parseScheduleCommand, and _claireOfflineClientResult/
// processVoiceCommandLocal straight out of index.html and drives real
// scenarios through them end to end.
//
// Run with: node tests/claire-auth-refresh.test.js

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

const apiSrc = extract(
  'async function _claireGetSessionToken(sb, forceRefresh) {',
  '\n\n// ── VOICE/TEXT COMMANDS ──'
);
const toolMetaSrc = extract('var CLAIRE_TOOL_META = {', 'async function processVoiceCommand(text) {');
const gateSrc = extract(
  'var _clairePendingProposals = []; // { id, html, sensitive }',
  '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom'
);
const localFallbackSrc = extract(
  'function _claireOfflineClientResult(lower, text, apiErrorReason) {',
  '\nfunction cancelVoiceCmd() {'
);

// ======================================================================
// SECTION A: _claireApi retries a stale/expired session before giving
// up -- getSession() first, refreshSession() if that's empty or if the
// server itself rejects the token with a 401.
// ======================================================================
function buildApiSandbox(opts) {
  opts = opts || {};
  const calls = { getSession: 0, refreshSession: 0, fetch: 0 };
  const sandbox = {
    console,
    window: {
      supabaseClient: {
        supabaseUrl: 'https://project.supabase.co',
        supabaseKey: 'anon-key',
        auth: {
          getSession: async () => {
            calls.getSession++;
            return { data: { session: opts.getSessionReturns ? opts.getSessionReturns(calls.getSession) : null } };
          },
          refreshSession: async () => {
            calls.refreshSession++;
            if (opts.refreshFails) return { data: { session: null } };
            return { data: { session: { access_token: 'refreshed-token-' + calls.refreshSession } } };
          },
        },
      },
    },
    fetch: async (url, init) => {
      calls.fetch++;
      return opts.fetchImpl(calls.fetch, init);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(apiSrc, sandbox);
  return { sandbox, calls };
}

async function main() {

// 1. getSession() already has a valid token -- no refresh needed, one fetch.
await (async () => {
  const { sandbox, calls } = buildApiSandbox({
    getSessionReturns: () => ({ access_token: 'good-token' }),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [] }) }),
  });
  const result = await sandbox._claireApi({ model: 'x' });
  check('a healthy session makes exactly one fetch call, no refresh needed', calls.fetch === 1 && calls.refreshSession === 0);
  check('the response is returned normally', Array.isArray(result.content));
})();

// 2. getSession() comes back EMPTY (the exact failure mode from the bug
// report) -- forces a real refreshSession() before giving up, and if
// THAT produces a token, the call still succeeds instead of throwing
// "no active session" immediately.
await (async () => {
  const { sandbox, calls } = buildApiSandbox({
    getSessionReturns: () => null, // getSession() always empty, matching the bug report
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ content: [] }) }),
  });
  const result = await sandbox._claireApi({ model: 'x' });
  check('an empty getSession() triggers a real refreshSession() call', calls.refreshSession >= 1);
  check('the call succeeds using the refreshed token instead of throwing immediately', Array.isArray(result.content));
  check('the fetch actually used the REFRESHED token, not a missing one', calls.fetch === 1);
})();

// 3. getSession() AND refreshSession() both genuinely fail -- only then
// does the signed-out message appear.
await (async () => {
  const { sandbox, calls } = buildApiSandbox({
    getSessionReturns: () => null,
    refreshFails: true,
    fetchImpl: async () => { throw new Error('should never be called'); },
  });
  let threw = null;
  try { await sandbox._claireApi({ model: 'x' }); } catch (e) { threw = e; }
  check('only when BOTH getSession and refreshSession genuinely fail does it throw', !!threw);
  check('the error message is the real "no active session" signed-out message', threw && /no active session/i.test(threw.message));
  check('no fetch was ever attempted with no usable token', calls.fetch === 0);
})();

// 4. The token LOOKS valid client-side (getSession succeeds) but the
// SERVER rejects it with a 401 anyway -- forces one refresh+retry
// before giving up, succeeding on the retried request.
await (async () => {
  const { sandbox, calls } = buildApiSandbox({
    getSessionReturns: () => ({ access_token: 'looks-valid-but-stale' }),
    fetchImpl: async (n) => {
      if (n === 1) return { ok: false, status: 401, text: async () => '' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: ['retried ok'] }) };
    },
  });
  const result = await sandbox._claireApi({ model: 'x' });
  check('a server-side 401 despite a client-side-valid-looking token triggers exactly one refresh+retry', calls.refreshSession === 1 && calls.fetch === 2);
  check('the retried request succeeds instead of surfacing a signed-out message', result.content[0] === 'retried ok');
})();

// 5. A 401 on the retry too (refresh itself produced a dead token, or
// the server is genuinely rejecting everything) -- only THEN does the
// signed-out message appear, never before a real refresh was tried.
await (async () => {
  const { sandbox, calls } = buildApiSandbox({
    getSessionReturns: () => ({ access_token: 'looks-valid-but-stale' }),
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }),
  });
  // After the retry still returns 401, _claireApi surfaces it as a
  // normal non-2xx error (not specifically re-thrown as "signed out"
  // again) -- confirms it does not loop forever and does not silently
  // succeed either.
  let threw = null;
  try { await sandbox._claireApi({ model: 'x' }); } catch (e) { threw = e; }
  check('a 401 that persists even after one refresh+retry still surfaces as an error (never silently succeeds)', !!threw);
  check('exactly one refresh and exactly two fetch attempts -- never an infinite retry loop', calls.refreshSession === 1 && calls.fetch === 2);
})();

// ======================================================================
// SECTION B: parseScheduleCommand resolves a bare first name SAFELY --
// a single match is used, more than one asks instead of guessing, and
// a confidentMatch flag distinguishes a confident match (full name OR
// an unambiguous first-name-only match) from a risky heuristic one
// (last-name-only, a raw substring with no ambiguity check at all).
// ======================================================================
function buildParseSandbox(clients) {
  const sandbox = {
    console,
    PentaClients: { forEachClient: (cb) => clients.forEach(cb) },
    dateKey: (d) => d.toISOString().slice(0, 10),
  };
  vm.createContext(sandbox);
  vm.runInContext(extract('function parseScheduleCommand(lower, original) {', '\n\n// v9.5.2: clientExtras'), sandbox);
  return sandbox;
}

{
  // The EXACT bug-report phrase, with only ONE "Lisa" in the book.
  const sandbox = buildParseSandbox([{ id: 'c1', fn: 'Lisa', ln: 'Finkel' }, { id: 'c2', fn: 'Alex', ln: 'Strong' }]);
  const result = sandbox.parseScheduleCommand('cancel lisa today', 'Cancel Lisa today');
  check('"Cancel Lisa today" resolves the single matching "Lisa" (the bug-report phrase, now fixed)', result.client && result.client.id === 'c1');
  check('an UNAMBIGUOUS first-name-only match IS confident (safe to act on -- Tom\'s phone test needs this to work)', result.confidentMatch === true);
}

{
  // Two clients named Lisa -- genuinely ambiguous, must ask, never guess.
  const sandbox = buildParseSandbox([{ id: 'c1', fn: 'Lisa', ln: 'Finkel' }, { id: 'c2', fn: 'Lisa', ln: 'Martinez' }]);
  const result = sandbox.parseScheduleCommand('cancel lisa today', 'Cancel Lisa today');
  check('two clients sharing a first name is reported as ambiguous_client, never a guess', result.error === 'ambiguous_client');
  check('the ambiguous result lists both candidates', result.candidates && result.candidates.length === 2);
}

{
  // A genuine full-name command is flagged as exact/confident.
  const sandbox = buildParseSandbox([{ id: 'c1', fn: 'Lisa', ln: 'Finkel' }]);
  const result = sandbox.parseScheduleCommand('cancel lisa finkel today', 'Cancel Lisa Finkel today');
  check('"Cancel Lisa Finkel today" (full name) is flagged as an exact, confident match', result.client && result.confidentMatch === true);
}

{
  // No match at all -- the plain "not found" error, unrelated to ambiguity.
  const sandbox = buildParseSandbox([{ id: 'c1', fn: 'Alex', ln: 'Strong' }]);
  const result = sandbox.parseScheduleCommand('cancel bob today', 'Cancel Bob today');
  check('no match at all is a plain "not found" error (not ambiguous_client)', !!result.error && result.error !== 'ambiguous_client');
}

// ======================================================================
// SECTION C: honest fallback messaging. processVoiceCommandLocal only
// ever runs because the real API call already failed -- it must NEVER
// claim a job/client doesn't exist (a false, specific-sounding
// diagnosis) when the real problem is the connection; it only acts on
// an exact, unambiguous full-name match, and asks (never guesses) on
// an ambiguous one.
// ======================================================================
function buildFallbackSandbox(clients, jobs) {
  const tables = { claire_proposals: [] };
  function makeFakeSupabase() {
    function execQuery(state) {
      let rows = (tables[state.table] || []).slice();
      state.filters.forEach((f) => { rows = rows.filter((r) => r[f[0]] === f[1]); });
      if (state.op === 'insert') {
        const obj = Object.assign({}, state.payload);
        obj.id = obj.id || 'id_' + Math.random().toString(36).slice(2);
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
  const fakeSb = makeFakeSupabase();
  const replies = [];
  const sandbox = {
    console,
    window: { supabaseClient: fakeSb, PentaTenant: { current: () => 'biz_1' }, PentaAuth: { client: fakeSb } },
    getCurrentAppRole: () => 'owner',
    isManagerRole: () => true,
    _pentaParseAuthToken: () => ({ user: { id: 'user_1' } }),
    _claireRenderBubble: () => {},
    PentaClients: { forEachClient: (cb) => clients.forEach(cb) },
    EMPLOYEE_ROSTER: [],
    jobs: jobs || [],
    dateKey: (d) => d.toISOString().slice(0, 10),
    saveJobs: () => {},
    manualTasks: [],
    saveManualTasks: () => {},
    renderTasks: () => {},
    logPendingUpdate: () => {},
    renderCal: () => {},
    claireReply: (msg) => { replies.push(msg); },
    _pentaJobWrite: async () => ({ ok: true }),
  };
  vm.createContext(sandbox);
  vm.runInContext(toolMetaSrc + '\n' + gateSrc + '\n' + extract('function parseScheduleCommand(lower, original) {', '\n\n// v9.5.2: clientExtras') + '\n' + localFallbackSrc, sandbox);
  return { sandbox, tables, replies };
}

await (async () => {
  // Exactly Tom's bug report: a single Lisa, API genuinely down.
  const { sandbox, tables, replies } = buildFallbackSandbox([{ id: 'c1', fn: 'Lisa', ln: 'Finkel' }]);
  await sandbox.processVoiceCommandLocal('Cancel Lisa today', 'You got signed out — sign back in and try again.');
  check('"Cancel Lisa today" with a single matching Lisa creates a proposal (the bug-report phrase, now fixed)', tables.claire_proposals.length === 1);
  check('the reply never falsely claims the job doesn\'t exist', !/couldn.?t find/i.test(replies[replies.length - 1] || ''));
})();

await (async () => {
  // Two Lisas -- must ask, not guess, not claim "not found."
  const { sandbox, tables, replies } = buildFallbackSandbox([{ id: 'c1', fn: 'Lisa', ln: 'Finkel' }, { id: 'c2', fn: 'Lisa', ln: 'Martinez' }]);
  await sandbox.processVoiceCommandLocal('Cancel Lisa today', 'You got signed out — sign back in and try again.');
  check('ambiguous "Lisa" creates no proposal (never guesses which one)', tables.claire_proposals.length === 0);
  check('ambiguous "Lisa" asks which one instead of claiming not found', /did you mean/i.test(replies[replies.length - 1] || ''));
})();

await (async () => {
  // No Lisa at all, with a genuine API failure reason -- must surface
  // the REAL reason, never "couldn't find that job."
  const { sandbox, tables, replies } = buildFallbackSandbox([{ id: 'c1', fn: 'Alex', ln: 'Strong' }]);
  await sandbox.processVoiceCommandLocal('Cancel Lisa today', 'You got signed out — sign back in and try again.');
  check('no match + a real API failure creates no proposal', tables.claire_proposals.length === 0);
  check('the REAL reason (the connection/sign-in problem) is shown, never a false "job not found" claim', replies[replies.length - 1] === 'You got signed out — sign back in and try again.');
})();

await (async () => {
  // A risky PARTIAL match (last-name-only) with a genuine API failure --
  // still not confident enough to act on; honest reason shown instead.
  const { sandbox, tables, replies } = buildFallbackSandbox([{ id: 'c1', fn: 'Lisa', ln: 'Finkelstein' }]);
  await sandbox.processVoiceCommandLocal('cancel the Finkelstein account today', 'You got signed out — sign back in and try again.');
  check('a risky partial match (last-name-only) during a real API failure does not act -- not confident enough', tables.claire_proposals.length === 0);
  check('the honest reason is shown instead of acting on a shaky guess', replies[replies.length - 1] === 'You got signed out — sign back in and try again.');
})();

await (async () => {
  // A genuine, confident EXACT full-name match still works fine even
  // during a real API failure -- "keep the offline parser only for
  // exact full-name commands" means it still WORKS for those.
  const { sandbox, tables, replies } = buildFallbackSandbox([{ id: 'c1', fn: 'Lisa', ln: 'Finkel' }]);
  await sandbox.processVoiceCommandLocal('Cancel Lisa Finkel today', 'You got signed out — sign back in and try again.');
  check('an exact full-name command still creates a proposal even during a real API failure', tables.claire_proposals.length === 1);
})();

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
