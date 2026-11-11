// Claire cleanup PART 2: uncancel_clean tool.
//
// Bug report: Claire had no way to restore a cancelled clean -- "un
// cancel it" got routed to cancel_clean (the only tool that matched),
// whose handler explicitly excludes already-cancelled jobs from its
// lookup, producing "couldn't find that job to cancel" instead of
// doing anything useful.
//
// This extracts the REAL _executeClaireToolCallInner (the 32-branch
// dispatcher -- only the cancel_clean/uncancel_clean branches are
// actually exercised; its other branches reference globals this file
// never stubs, which is fine since they're never invoked), the full
// approval-gate module, and processVoiceCommandLocal (the offline
// fallback) straight out of index.html, and drives real phrases/tool
// calls through them end to end.
//
// Run with: node tests/claire-uncancel-tool.test.js

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
const gateSrc = extract(
  'var _clairePendingProposals = []; // { id, html, sensitive }',
  '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom'
);
const dispatcherSrc = extract(
  'async function executeClaireToolCall(toolCall, message) {',
  '\n\n// (legacy — replaced by executeClaireToolCall)'
);
const localFallbackSrc = extract(
  'async function processVoiceCommandLocal(text, apiErrorReason) {',
  '\nfunction cancelVoiceCmd() {'
);
const parseSrc = extract(
  'function parseScheduleCommand(lower, original) {',
  '\n\n// v9.5.2: clientExtras'
);

const COMBINED_SRC = toolMetaSrc + '\n' + gateSrc + '\n' + dispatcherSrc + '\n' + localFallbackSrc + '\n' + parseSrc;

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
    if (state.op === 'update') rows.forEach((r) => Object.assign(r, state.payload));
    if (state.single) return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
    return { data: rows, error: null };
  }
  function builder(table) {
    const state = { table, filters: [], op: null, payload: null, single: false };
    const b = {
      insert: (o) => { state.op = 'insert'; state.payload = o; return b; },
      update: (o) => { state.op = 'update'; state.payload = o; return b; },
      select: () => { if (!state.op) state.op = 'select'; return b; },
      eq: (k, v) => { state.filters.push([k, v]); return b; },
      order: () => b,
      limit: () => b,
      single: () => { state.single = true; return Promise.resolve(execQuery(state)); },
      then: (resolve, reject) => Promise.resolve(execQuery(state)).then(resolve, reject),
    };
    return b;
  }
  return { from: (table) => builder(table), auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } };
}

function buildSandbox(opts) {
  opts = opts || {};
  const tables = { claire_proposals: [] };
  const fakeSb = makeFakeSupabase(tables);
  const replies = [];
  const jobWrites = [];
  const clients = opts.clients || [{ id: 'c1', fn: 'Alex', ln: 'Strong' }];
  const jobs = opts.jobs || [];
  const cards = {};
  function makeCard() {
    const statusEl = { textContent: '' };
    return { querySelector: (sel) => (sel === '.claire-proposal-status' ? statusEl : null), querySelectorAll: () => [] };
  }
  const sandbox = {
    console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    window: { supabaseClient: fakeSb, confirm: () => true, PentaTenant: { current: () => 'biz_1' }, PentaAuth: { client: fakeSb } },
    document: {
      getElementById: (id) => {
        if (id === 'voice-cmd-status') return { innerHTML: '', style: {} };
        if (id.indexOf('claire-proposal-') === 0) return makeCard();
        return null;
      },
    },
    getCurrentAppRole: () => opts.role || 'owner',
    isManagerRole: () => true,
    _pentaParseAuthToken: () => ({ user: { id: 'user_1' } }),
    _claireRenderBubble: () => {},
    PentaClients: { forEachClient: (cb) => clients.forEach(cb) },
    EMPLOYEE_ROSTER: [],
    PentaEmployees: null,
    jobs,
    dateKey: (d) => d.toISOString().slice(0, 10),
    saveJobs: () => {},
    saveDailyAssignments: () => {},
    dailyAssignments: {},
    manualTasks: [],
    saveManualTasks: () => {},
    renderTasks: () => {},
    logPendingUpdate: () => {},
    renderCal: () => {},
    _pentaTeamColor: () => '#000',
    claireReply: (msg) => { replies.push(msg); },
    _pentaJobWrite: async (op, args) => { jobWrites.push({ op, args }); return { ok: true }; },
    _claireLastToolResult: '',
    _claireLastToolSmsLink: null,
    _claireSilent: false,
    // findClientWithSuggestions is a well-isolated collaborator (name
    // resolution, fuzzy matching) unrelated to what PART 2 changed --
    // stubbed deterministically, same convention as the other Claire
    // test files use for DOM/facade collaborators.
    findClientWithSuggestions: (query) => {
      const q = String(query || '').toLowerCase();
      const m = clients.filter((c) => (c.fn + ' ' + c.ln).toLowerCase() === q || (c.fn + ' ' + c.ln).toLowerCase().indexOf(q) !== -1);
      return { matches: m, suggestions: [] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return { sandbox, tables, replies, jobWrites, jobs };
}

async function main() {

// ======================================================================
// 1. Classification: uncancel_clean is a real, separate, non-sensitive
//    gated WRITE tool.
// ======================================================================
{
  const { sandbox } = buildSandbox({});
  const meta = sandbox._claireToolMeta('uncancel_clean');
  check('uncancel_clean is gated (not immediate execution)', meta.gate === true);
  check('uncancel_clean is NOT sensitive (a manager can propose it)', meta.sensitive !== true);
}

// ======================================================================
// 2. Through the gate: uncancel_clean creates a proposal, not an
//    immediate write.
// ======================================================================
await (async () => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const { sandbox, tables, jobWrites } = buildSandbox({ jobs: [{ id: 'j1', clientId: 'c1', clientName: 'Strong, Alex', date: dateKey, cancelled: true }] });
  const r = await sandbox._claireDispatchOrPropose({ name: 'uncancel_clean', input: { client: 'Alex Strong', date: dateKey } }, null);
  check('uncancel_clean creates exactly one proposal', tables.claire_proposals.length === 1);
  check('uncancel_clean never writes before Approve', jobWrites.length === 0);
  check('the proposal summary describes a restore, not a cancel', /restore/i.test(tables.claire_proposals[0].summary));
  check('the tool_result never claims the clean is already restored', !/done!|restored\./i.test(r) && /waiting for your approval/i.test(r));
})();

// ======================================================================
// 3. Approve actually restores the job -- resolves CANCELLED jobs
//    (cancel_clean's own lookup explicitly excludes these; uncancel_clean
//    must do the opposite).
// ======================================================================
await (async () => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const job = { id: 'j1', clientId: 'c1', clientName: 'Strong, Alex', date: dateKey, cancelled: true, cancelReason: 'Client · Rescheduling' };
  const { sandbox, tables, jobWrites } = buildSandbox({ jobs: [job] });
  await sandbox._claireDispatchOrPropose({ name: 'uncancel_clean', input: { client: 'Alex Strong', date: dateKey } }, null);
  const proposalId = tables.claire_proposals[0].id;
  await sandbox._claireApproveProposal(proposalId);
  check('Approve restores the job (cancelled=false)', job.cancelled === false);
  check('Approve clears the cancel reason too', job.cancelReason === null);
  check('Approve writes via the SAME existing _pentaJobWrite path cancelJob() already uses', jobWrites.length === 1 && jobWrites[0].op === 'update' && jobWrites[0].args.patch.cancelled === false);
  check('the proposal is marked executed', tables.claire_proposals[0].status === 'executed');
})();

// ======================================================================
// 4. uncancel_clean on a job that ISN'T cancelled says so plainly,
//    writes nothing.
// ======================================================================
await (async () => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const job = { id: 'j1', clientId: 'c1', clientName: 'Strong, Alex', date: dateKey, cancelled: false };
  const { sandbox, replies, jobWrites } = buildSandbox({ jobs: [job] });
  await sandbox.executeClaireToolCall({ name: 'uncancel_clean', input: { client: 'Alex Strong', date: dateKey } }, null);
  check('uncancel_clean on an active (not cancelled) job changes nothing', job.cancelled === false && jobWrites.length === 0);
  check('uncancel_clean replies that it is not cancelled, not a generic error', /isn.?t cancelled/i.test(replies[replies.length - 1] || ''));
})();

// ======================================================================
// 5. uncancel_clean with no matching job at all (any state) says so.
// ======================================================================
await (async () => {
  const { sandbox, replies, jobWrites } = buildSandbox({ jobs: [] });
  await sandbox.executeClaireToolCall({ name: 'uncancel_clean', input: { client: 'Alex Strong', date: '2026-01-01' } }, null);
  check('uncancel_clean with no job at all writes nothing', jobWrites.length === 0);
  check('uncancel_clean replies honestly when nothing was found', /couldn.?t find a cancelled clean/i.test(replies[replies.length - 1] || ''));
})();

// ======================================================================
// 6. cancel_clean on an ALREADY-cancelled job: the exact bug-report
//    symptom, now fixed with the specific message instead of the
//    generic "no clean scheduled."
// ======================================================================
await (async () => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const job = { id: 'j1', clientId: 'c1', clientName: 'Strong, Alex', date: dateKey, cancelled: true };
  const { sandbox, replies, jobWrites } = buildSandbox({ jobs: [job] });
  await sandbox.executeClaireToolCall({ name: 'cancel_clean', input: { client: 'Alex Strong', date: dateKey } }, null);
  check('cancel_clean on an already-cancelled job writes nothing', jobWrites.length === 0);
  check('cancel_clean on an already-cancelled job gives the exact bug-report-fix message', /already cancelled.*restore it/i.test(replies[replies.length - 1] || ''));
})();

// ======================================================================
// 7. Offline fallback (processVoiceCommandLocal): uncancel/restore
//    phrases create a GATED proposal, never a direct write -- and are
//    never swallowed by the "cancel" branch ("uncancel" contains
//    "cancel" as a substring).
// ======================================================================
await (async () => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const { sandbox, tables, jobWrites } = buildSandbox({ jobs: [{ id: 'j1', clientId: 'c1', clientName: 'Strong, Alex', date: dateKey, cancelled: true }] });
  await sandbox.processVoiceCommandLocal('uncancel the Alex Strong clean for today', 'API unavailable');
  check('"uncancel the <client> clean" through the offline fallback creates a proposal', tables.claire_proposals.length === 1);
  check('"uncancel the <client> clean" is NOT swallowed by the cancel branch', tables.claire_proposals[0].tool_name === 'uncancel_clean');
  check('the offline fallback never writes directly for uncancel either', jobWrites.length === 0);
})();

await (async () => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const { sandbox, tables } = buildSandbox({ jobs: [{ id: 'j1', clientId: 'c1', clientName: 'Strong, Alex', date: dateKey, cancelled: true }] });
  await sandbox.processVoiceCommandLocal('restore the Alex Strong clean for today', 'API unavailable');
  check('"restore the <client> clean" through the offline fallback also routes to uncancel_clean', tables.claire_proposals.length === 1 && tables.claire_proposals[0].tool_name === 'uncancel_clean');
})();

await (async () => {
  const dateKey = new Date().toISOString().slice(0, 10);
  const { sandbox, tables, jobWrites } = buildSandbox({ jobs: [{ id: 'j1', clientId: 'c1', clientName: 'Strong, Alex', date: dateKey, cancelled: false }] });
  await sandbox.processVoiceCommandLocal('cancel the Alex Strong clean for today', 'API unavailable');
  check('a genuine "cancel" phrase (no "un" prefix) still routes to cancel_clean, not uncancel_clean', tables.claire_proposals.length === 1 && tables.claire_proposals[0].tool_name === 'cancel_clean');
})();

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
