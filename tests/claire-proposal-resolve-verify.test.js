// Claire proposal-resolve-verify.
//
// BUG (Tom's phone, reported after PR #224): "cancel Lisa's clean for
// today" got a proposal card whose text said only "Proposal created:
// cancel a client clean" -- no client, date, or time. He tapped
// Approve, the card said "Done," but the clean was still on the
// schedule. Two bugs: (1) the proposal summary never named what would
// change because _claireDispatchOrPropose built it from the model's
// RAW, unresolved tool input (falling back to placeholder text like
// "a client" whenever a field was missing/empty) with zero database
// lookup; (2) _claireApproveProposal only distinguished success from
// failure by whether executeClaireToolCall THREW -- several dispatcher
// branches (job not found, already in the target state, or a write
// that got silently queued/rejected) returned normally with no actual
// change, so Approve marked them 'executed' and showed "Done" anyway.
//
// Fix: resolve the client + the specific job from the database BEFORE
// a proposal is created (ambiguity-safe: a single match wins, more
// than one asks which, none says so and creates nothing), store the
// resolved ids in the proposal's args, build the summary from that
// resolved record, and have Approve run by the resolved id then verify
// the actual post-write state before ever reporting "Done."
//
// This extracts the REAL CLAIRE_TOOL_META/_claireToolMeta, the full
// client/job resolver chain (_cleanName/findClients/
// findClientWithSuggestions/_claireTodayKey/_claireResolveClientJob/
// _claireFindMoveSourceJob/_claireResolveMoveClean/
// _claireResolveScheduleClean/_claireResolvedSummary/etc.), the full
// gate/approve module, and executeClaireToolCall/_executeClaireToolCallInner
// (the real 32-branch dispatcher -- only its cancel/uncancel/move/
// schedule_clean branches are exercised) straight out of index.html.
// _bizTodayParts/_pentaBusinessTimezone/PentaClients/jobs/window.PentaJobs
// are sandbox fakes standing in for the database.
//
// Run with: node tests/claire-proposal-resolve-verify.test.js

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

const toolMetaSrc = extract('var CLAIRE_TOOL_META = {', 'async function processVoiceCommand(text) {');
const resolversSrc = extract(
  'function _cleanName(s) {',
  '\n// Ranked employee matcher, mirrors findClients() above'
);
const gateSrc = extract(
  'var _clairePendingProposals = []; // { id, html, sensitive }',
  '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom'
);
const dispatcherSrc = extract(
  'async function executeClaireToolCall(toolCall, message) {',
  '\n\n// (legacy — replaced by executeClaireToolCall)'
);

const COMBINED_SRC = toolMetaSrc + '\n' + resolversSrc + '\n' + gateSrc + '\n' + dispatcherSrc;

// ---- in-memory fake Supabase query builder (same shape as the other
// Claire test files) -----------------------------------------------
function makeFakeSupabase(tables) {
  function execQuery(state) {
    let rows = (tables[state.table] || []).slice();
    state.filters.forEach(function (f) { rows = rows.filter(function (r) { return r[f[0]] === f[1]; }); });
    if (state.op === 'insert') {
      const obj = Object.assign({}, state.payload);
      if (!obj.id) obj.id = 'id_' + Math.random().toString(36).slice(2);
      if (!obj.created_at) obj.created_at = new Date().toISOString();
      if (!('status' in obj)) obj.status = 'pending';
      if (!('risk' in obj)) obj.risk = 'normal';
      if (!('expires_at' in obj)) obj.expires_at = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      tables[state.table] = tables[state.table] || [];
      tables[state.table].push(obj);
      rows = [obj];
    }
    if (state.op === 'update') rows.forEach(function (r) { Object.assign(r, state.payload); });
    if (state.single) return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
    return { data: rows, error: null };
  }
  function builder(table) {
    const state = { table: table, filters: [], op: null, payload: null, single: false };
    const b = {
      insert: function (o) { state.op = 'insert'; state.payload = o; return b; },
      update: function (o) { state.op = 'update'; state.payload = o; return b; },
      select: function () { if (!state.op) state.op = 'select'; return b; },
      eq: function (k, v) { state.filters.push([k, v]); return b; },
      order: function () { return b; },
      limit: function () { return b; },
      single: function () { state.single = true; return Promise.resolve(execQuery(state)); },
      then: function (resolve, reject) { return Promise.resolve(execQuery(state)).then(resolve, reject); },
    };
    return b;
  }
  return { from: function (table) { return builder(table); }, auth: { getSession: async function () { return { data: { session: { access_token: 'tok' } } }; } } };
}

// ---- sandbox factory --------------------------------------------------
// Default fixture: ONE client ("Lisa Finkel") with one active job dated
// 2026-11-11 (a Wednesday), and _bizTodayParts also resolves "today" to
// that same date by default -- so the bug-report phrase ("cancel Lisa's
// clean for today") and an explicit date:'2026-11-11' resolve to the
// SAME real job.
function buildSandbox(opts) {
  opts = opts || {};
  const tables = { claire_proposals: [] };
  const fakeSb = makeFakeSupabase(tables);
  const cards = {};
  function makeCard(id) {
    const statusEl = { textContent: '' };
    const btns = [{ disabled: false }, { disabled: false }];
    return { querySelector: function (sel) { return sel === '.claire-proposal-status' ? statusEl : null; }, querySelectorAll: function () { return btns; }, _statusEl: statusEl };
  }

  const defaultClients = opts.clients || [{ id: 'c_lisa', fn: 'Lisa', ln: 'Finkel' }];
  // jobs is the "server mirror" PentaJobs.getById reads from, letting
  // _executeClaireToolCallInner's post-write verification be real --
  // if _pentaJobWrite is told to fail, this mirror is NOT updated, so
  // getById(...).cancelled still shows the old value.
  const serverJobs = (opts.jobs || [{ id: 'job_1', clientId: 'c_lisa', clientName: 'Finkel, Lisa', date: '2026-11-11', time: '09:00', team: 'B1', cancelled: false }]).map(function (j) { return Object.assign({}, j); });
  const jobsArr = serverJobs.map(function (j) { return Object.assign({}, j); }); // in-memory working copy, mutated optimistically by the dispatcher
  const todayParts = opts.today || { y: 2026, m: 11, d: 11 };
  const writeLog = [];

  const PentaClientsFake = {
    forEachClient: function (fn) { defaultClients.forEach(fn); },
    getClient: function (id) { return defaultClients.find(function (c) { return c.id === id; }) || null; },
  };
  const PentaJobsFake = {
    getById: function (id) { return serverJobs.find(function (j) { return j.id === id; }) || null; },
  };

  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    window: { supabaseClient: fakeSb, confirm: function () { return true; }, _pendingVoiceCmd: null, PentaJobs: PentaJobsFake, PentaAuth: { client: fakeSb }, PentaTenant: { current: function () { return 'biz_1'; } } },
    document: {
      getElementById: function (id) {
        if (id === 'voice-cmd-status') return { innerHTML: '', style: {} };
        if (id.indexOf('claire-proposal-') === 0) {
          const pid = id.slice('claire-proposal-'.length);
          if (!cards[pid]) cards[pid] = makeCard(pid);
          return cards[pid];
        }
        return null;
      },
    },
    getCurrentAppRole: function () { return opts.role || 'owner'; },
    isManagerRole: function () { return true; },
    _pentaParseAuthToken: function () { return { user: { id: 'user_1' } }; },
    jobs: jobsArr,
    PentaClients: PentaClientsFake,
    EMPLOYEE_ROSTER: [],
    findEmployeeWithSuggestions: function () { return { matches: [], suggestions: [] }; },
    _bizTodayParts: function () { return todayParts; },
    _pentaBusinessTimezone: function () { return 'America/New_York'; },
    saveJobs: function () {},
    recalcTeamTimes: function () {},
    logPendingUpdate: function () {},
    renderCal: function () {},
    claireReply: function () {},
    _pentaTeamColor: function () { return '#000'; },
    // The write "server": by default applies the patch to the server
    // mirror (so getById-based verification sees it) and returns
    // {ok:true}. opts.writeFails makes it a no-op queued failure --
    // the exact shape _pentaJobWrite returns for a real queued/rejected
    // write -- so verification must catch it even though the caller
    // never threw.
    _pentaJobWrite: async function (op, args) {
      writeLog.push({ op: op, args: args });
      if (opts.writeFails) return { ok: false, queued: true };
      if (op === 'update') {
        const row = serverJobs.find(function (j) { return j.id === args.id; });
        if (row) Object.assign(row, args.patch);
      }
      return { ok: true, data: args };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return { sandbox: sandbox, tables: tables, jobsArr: jobsArr, serverJobs: serverJobs, writeLog: writeLog, cards: cards };
}

async function main() {

// ======================================================================
// 1. First-name single match produces a NAMED summary (the bug-report
//    phrase itself: "cancel Lisa's clean for today").
// ======================================================================
await (async () => {
  const { sandbox, tables } = buildSandbox({});
  const r = await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Lisa' } }, null);
  check('a bare first name with exactly one match creates a proposal', tables.claire_proposals.length === 1);
  const summary = tables.claire_proposals[0].summary;
  check('the summary names the client (never "a client")', /Lisa F\./.test(summary) && !/a client/i.test(summary));
  check('the summary names the date', /Wed, Nov 11/.test(summary));
  check('the summary names the time', /9:00 AM/.test(summary));
  check('the summary names the team', /team B1/i.test(summary));
  check('Claire\'s own reply (not just the card) also names the client -- STEP 4', /Lisa F\./.test(r) && !/a client/i.test(r));
})();

// ======================================================================
// 2. Two Lisas: asks which, never guesses, creates no proposal.
// ======================================================================
await (async () => {
  const twoLisas = [{ id: 'c1', fn: 'Lisa', ln: 'Finkel' }, { id: 'c2', fn: 'Lisa', ln: 'Owens' }];
  const { sandbox, tables } = buildSandbox({ clients: twoLisas });
  const r = await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Lisa' } }, null);
  check('an ambiguous first name creates NO proposal', tables.claire_proposals.length === 0);
  check('both candidates are named so Tom can say which one', /Lisa Finkel/.test(r) && /Lisa Owens/.test(r));
})();

// ======================================================================
// 3. No match at all: no proposal, plain honest message.
// ======================================================================
await (async () => {
  const { sandbox, tables } = buildSandbox({});
  const r = await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Nobody' } }, null);
  check('no match creates no proposal', tables.claire_proposals.length === 0);
  check('the message says plainly nothing was found, not a placeholder', /couldn't find that client/i.test(r));
})();

// ======================================================================
// 4. Approve runs by the resolved job id, VERIFIES the actual post-
//    write state, and only reports success when it genuinely changed.
// ======================================================================
await (async () => {
  // Happy path: the write really lands -- Approve marks executed, "Done."
  const { sandbox, tables, serverJobs } = buildSandbox({});
  await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Lisa', date: '2026-11-11' } }, null);
  const id = tables.claire_proposals[0].id;
  await sandbox._claireApproveProposal(id);
  check('a genuinely successful cancel is marked executed', tables.claire_proposals[0].status === 'executed');
  check('the server-side job (verified via PentaJobs.getById) is actually cancelled', serverJobs[0].cancelled === true);
})();

await (async () => {
  // The exact bug: the write is silently queued/rejected (never throws),
  // so the ONLY way to catch it is re-reading the actual post-write state.
  const { sandbox, tables, serverJobs } = buildSandbox({ writeFails: true });
  await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Lisa', date: '2026-11-11' } }, null);
  const id = tables.claire_proposals[0].id;
  const card = sandbox.document.getElementById('claire-proposal-' + id);
  await sandbox._claireApproveProposal(id);
  check('a write that never actually lands is marked FAILED, never "executed"', tables.claire_proposals[0].status === 'failed');
  check('the card shows a concrete, honest error -- never "Done" for an unchanged job', /failed/i.test(card._statusEl.textContent) && !/^done\.?$/i.test(card._statusEl.textContent));
  check('the job genuinely was not changed -- the error matches reality', serverJobs[0].cancelled === false);
  check('the proposal error text is specific, not empty', !!tables.claire_proposals[0].error);
})();

await (async () => {
  // Race condition: the job was ALREADY cancelled by the time Approve ran
  // (e.g. a second request) -- also a failure, never a false "Done."
  const { sandbox, tables, jobsArr, serverJobs } = buildSandbox({});
  await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Lisa', date: '2026-11-11' } }, null);
  const id = tables.claire_proposals[0].id;
  jobsArr[0].cancelled = true; serverJobs[0].cancelled = true; // simulate the race
  await sandbox._claireApproveProposal(id);
  check('approving a proposal whose job already changed state is marked failed, not executed', tables.claire_proposals[0].status === 'failed');
})();

// ======================================================================
// 5. "today" resolves in the BUSINESS's timezone, not UTC/device-local --
//    a late-evening Eastern request near midnight UTC still resolves to
//    the SAME Eastern calendar day, not the next one.
// ======================================================================
// The interesting case for the business-timezone bug: a moment where
// UTC has already rolled to the next day but the business's own
// configured timezone has not (e.g. 2026-11-12 02:30 UTC is still
// 2026-11-11 21:30 America/New_York). _bizTodayParts is the single
// source of truth for "today" here -- the two sub-tests below prove
// the resolver actually USES it (matching when it agrees with the
// job's date, failing to match when it's shifted), rather than
// silently falling back to the device/UTC clock.
await (async () => {
  const { sandbox, tables } = buildSandbox({ today: { y: 2026, m: 11, d: 11 } });
  await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Lisa' } }, null);
  check('an omitted date resolves "today" from _bizTodayParts (business timezone) and finds the real job', tables.claire_proposals.length === 1 && tables.claire_proposals[0].args._resolvedJobId === 'job_1');
})();
await (async () => {
  // If "today" had instead been computed from UTC/device-local and
  // rolled to the 12th while the business's own day is still the 11th,
  // this same job (dated the 11th) would NOT be found.
  const { sandbox, tables } = buildSandbox({ today: { y: 2026, m: 11, d: 12 } });
  const r = await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Lisa' } }, null);
  check('a "today" that disagrees with the job\'s actual date (simulating the UTC-vs-business-timezone mismatch) correctly finds nothing, proving the date is NOT hardcoded/ignored', tables.claire_proposals.length === 0 && /has no clean/i.test(r));
})();

// ======================================================================
// 6. Summaries for uncancel_clean, move_clean, and schedule_clean all
//    name the client and date (STEP 5 coverage for the other 3
//    explicitly-named job-write tools).
// ======================================================================
await (async () => {
  const cancelledJob = [{ id: 'job_1', clientId: 'c_lisa', clientName: 'Finkel, Lisa', date: '2026-11-11', time: '09:00', team: 'B1', cancelled: true }];
  const { sandbox, tables } = buildSandbox({ jobs: cancelledJob });
  await sandbox._claireDispatchOrPropose({ name: 'uncancel_clean', input: { client: 'Lisa', date: '2026-11-11' } }, null);
  check('uncancel_clean\'s summary names the client and date', tables.claire_proposals.length === 1 && /Lisa F\./.test(tables.claire_proposals[0].summary) && /Wed, Nov 11/.test(tables.claire_proposals[0].summary));
})();
await (async () => {
  const { sandbox, tables } = buildSandbox({});
  await sandbox._claireDispatchOrPropose({ name: 'move_clean', input: { client: 'Lisa', to_date: '2026-11-13', time: '10:00', team: 'B3' } }, null);
  check('move_clean\'s summary names the client and BOTH dates', tables.claire_proposals.length === 1 && /Lisa F\./.test(tables.claire_proposals[0].summary) && /Wed, Nov 11/.test(tables.claire_proposals[0].summary) && /Fri, Nov 13/.test(tables.claire_proposals[0].summary));
  check('move_clean stores the resolved destination fields for Approve to use directly', tables.claire_proposals[0].args._resolvedToDate === '2026-11-13' && tables.claire_proposals[0].args._resolvedTeam === 'B3');
})();
await (async () => {
  const { sandbox, tables } = buildSandbox({});
  await sandbox._claireDispatchOrPropose({ name: 'schedule_clean', input: { client: 'Lisa', date: '2026-11-20', time: '14:00', team: 'S1' } }, null);
  check('schedule_clean\'s summary names the client and date', tables.claire_proposals.length === 1 && /Lisa F\./.test(tables.claire_proposals[0].summary) && /Fri, Nov 20/.test(tables.claire_proposals[0].summary));
})();

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
