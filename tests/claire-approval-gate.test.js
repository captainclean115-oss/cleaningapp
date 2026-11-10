// Claire safety foundation (Stage 2a) -- approval gate tests.
//
// Extracts the REAL CLAIRE_TOOL_META classification, _claireToolMeta,
// _claireSessionInfo, _claireIsOwnerOrAdmin, isManagerRole, and the full
// gate/proposal/approve/reject/approve-all/badge functions straight out
// of index.html (not reimplementations). Supabase is a small in-memory
// fake query-builder (insert/update/delete/select/eq/order/limit/
// single/maybeSingle, matching supabase-js's chainable shape) so the
// REAL control flow (role checks, idempotent claim-by-status, proposal
// creation) runs against real async stubs, per the house rule that
// test stubs must be async and match production behavior.
//
// Run with: node tests/claire-approval-gate.test.js

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

const toolMetaSrc = extract(
  'var CLAIRE_TOOL_META = {',
  'async function processVoiceCommand(text) {'
);
const isManagerRoleSrc = extract(
  'function isManagerRole() {',
  '\n\n// Hook the existing onAuthStateChange'
);
const gateSrc = extract(
  'var _clairePendingProposals = []; // { id, html, sensitive }',
  '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom'
);

const COMBINED_SRC = toolMetaSrc + '\n' + isManagerRoleSrc + '\n' + gateSrc;

// ---- in-memory fake Supabase query builder --------------------------
// Mirrors the chainable shape this code actually uses: from().insert()/
// update()/delete()/select().eq()...order()/limit()/single()/
// maybeSingle(), and the bare builder itself is awaitable (a plain
// update/delete with no .select() just gets {data,error}).
function makeFakeSupabase(tables, opts) {
  opts = opts || {};
  function execQuery(state) {
    let rows = (tables[state.table] || []).slice();
    state.filters.forEach(function (f) {
      rows = rows.filter(function (r) { return r[f[0]] === f[1]; });
    });
    if (state.op === 'delete') {
      const toDelete = rows;
      tables[state.table] = (tables[state.table] || []).filter(function (r) { return toDelete.indexOf(r) === -1; });
      return { data: null, error: null };
    }
    if (state.op === 'insert') {
      const obj = Object.assign({}, state.payload);
      if (!obj.id) obj.id = 'id_' + Math.random().toString(36).slice(2);
      if (!obj.created_at) obj.created_at = new Date().toISOString();
      if (state.table === 'claire_proposals') {
        if (!('status' in obj)) obj.status = 'pending';
        if (!('risk' in obj)) obj.risk = 'normal';
        if (!('expires_at' in obj)) obj.expires_at = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
      }
      tables[state.table] = tables[state.table] || [];
      tables[state.table].push(obj);
      rows = [obj];
    }
    if (state.op === 'update') {
      rows.forEach(function (r) { Object.assign(r, state.payload); });
    }
    if (state.order) {
      const col = state.order[0], asc = state.order[1] && state.order[1].ascending;
      rows.sort(function (a, b) {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (state.limit != null) rows = rows.slice(0, state.limit);
    if (state.selectOpts && state.selectOpts.count === 'exact' && state.selectOpts.head) {
      return { data: null, error: null, count: rows.length };
    }
    if (state.single) {
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows (single)' } };
    }
    if (state.maybeSingle) {
      return { data: rows[0] || null, error: null };
    }
    return { data: rows, error: null };
  }
  function builder(table) {
    const state = { table: table, filters: [], op: null, payload: null, selectOpts: null, single: false, maybeSingle: false, order: null, limit: null };
    const b = {
      insert: function (obj) { state.op = 'insert'; state.payload = obj; return b; },
      update: function (obj) { state.op = 'update'; state.payload = obj; return b; },
      delete: function () { state.op = 'delete'; return b; },
      select: function (cols, selOpts) { state.selectOpts = selOpts || null; return b; },
      eq: function (k, v) { state.filters.push([k, v]); return b; },
      order: function (col, o) { state.order = [col, o]; return b; },
      limit: function (n) { state.limit = n; return b; },
      single: function () { state.single = true; return Promise.resolve(execQuery(state)); },
      maybeSingle: function () { state.maybeSingle = true; return Promise.resolve(execQuery(state)); },
      then: function (resolve, reject) { return Promise.resolve(execQuery(state)).then(resolve, reject); },
    };
    return b;
  }
  return {
    from: function (table) { return builder(table); },
    auth: {
      getSession: async function () {
        return { data: { session: opts.sessionActive === false ? null : { access_token: 'tok' } } };
      },
    },
  };
}

// ---- sandbox factory --------------------------------------------------
function buildSandbox(opts) {
  opts = opts || {};
  const tables = { claire_proposals: [], claire_chat_sessions: [] };
  const fakeSb = makeFakeSupabase(tables, { sessionActive: opts.sessionActive !== false });
  const executeCalls = [];
  const cards = {}; // id -> fake DOM card
  function makeCard(id) {
    const statusEl = { textContent: '' };
    const btns = [{ disabled: false }, { disabled: false }];
    return {
      querySelector: function (sel) { return sel === '.claire-proposal-status' ? statusEl : null; },
      querySelectorAll: function () { return btns; },
      _statusEl: statusEl,
      _btns: btns,
    };
  }
  const sandbox = {
    console: console,
    window: {
      supabaseClient: fakeSb,
      confirm: function () { return opts.confirmReturns !== false; },
      _pendingVoiceCmd: null,
    },
    document: {
      getElementById: function (id) {
        if (id.indexOf('claire-proposal-') === 0) {
          const pid = id.slice('claire-proposal-'.length);
          if (!cards[pid]) cards[pid] = makeCard(pid);
          return cards[pid];
        }
        return null;
      },
    },
    getCurrentAppRole: function () { return opts.role; },
    _pentaParseAuthToken: function () { return { user: { id: opts.authUserId || 'user_1' } }; },
    executeClaireToolCall: async function (toolCall, message) {
      executeCalls.push({ name: toolCall.name, input: toolCall.input });
      if (opts.executeThrows) throw new Error(opts.executeThrows);
      return 'Executed ' + toolCall.name + '.';
    },
    executeScheduleCmd: async function () {
      executeCalls.push({ name: '__executeScheduleCmd__' });
    },
  };
  sandbox.window.PentaAuth = { client: fakeSb };
  sandbox.window.PentaTenant = { current: function () { return opts.businessId || 'biz_1'; } };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return { sandbox: sandbox, tables: tables, executeCalls: executeCalls, cards: cards };
}

async function main() {

// ======================================================================
// 1. Tool classification -- every real tool is accounted for, fail-safe default.
// ======================================================================
{
  const { sandbox } = buildSandbox({ role: 'owner' });
  const READS = ['lookup_client','lookup_schedule','lookup_balance','lookup_employee','count_jobs','get_revenue','compute_quote','get_employee_hours','locate_team','query_clients','revenue_summary','accounts_receivable_summary','cancellation_analysis','team_performance','at_risk_clients','send_message','send_invoice','send_response_to'];
  const WRITES = ['schedule_clean','cancel_clean','move_clean','employee_day_off','move_employee','add_reminder','change_frequency','update_client_notes','edit_client','send_text','change_price','record_payment','edit_employee_hours','batch_edit_employee_hours'];
  check('all 18 read/exempt tools have gate:false', READS.every(n => sandbox._claireToolMeta(n).gate === false));
  check('all 14 write tools have gate:true', WRITES.every(n => sandbox._claireToolMeta(n).gate === true));
  const SENSITIVE = ['change_price','record_payment','edit_employee_hours','batch_edit_employee_hours'];
  check('exactly the 4 sensitive tools are marked sensitive', SENSITIVE.every(n => sandbox._claireToolMeta(n).sensitive === true) && WRITES.filter(n => SENSITIVE.indexOf(n) === -1).every(n => !sandbox._claireToolMeta(n).sensitive));
  check('an unknown/future tool fails SAFE (gated + sensitive) instead of running free', sandbox._claireToolMeta('some_brand_new_tool').gate === true && sandbox._claireToolMeta('some_brand_new_tool').sensitive === true);
}

// ======================================================================
// 2. READ tools still run immediately (unaffected).
// ======================================================================
{
  const { sandbox, executeCalls, tables } = buildSandbox({ role: 'owner' });
  await (async () => {
    const r = await sandbox._claireDispatchOrPropose({ name: 'lookup_client', input: { client: 'Alex Strong' } }, '');
    check('a READ tool runs via executeClaireToolCall immediately', executeCalls.length === 1 && executeCalls[0].name === 'lookup_client');
    check('a READ tool creates no proposal row', tables.claire_proposals.length === 0);
    check('a READ tool returns executeClaireToolCall\'s own result string', r === 'Executed lookup_client.');
  })();
}

// batch_edit_employee_hours preview-only (confirmed:false) call bypasses the gate too.
{
  const { sandbox, executeCalls, tables } = buildSandbox({ role: 'manager' });
  await (async () => {
    await sandbox._claireDispatchOrPropose({ name: 'batch_edit_employee_hours', input: { entries: [{employee:'Nadia'}] } }, '');
    check('batch_edit_employee_hours preview-only (confirmed omitted) runs immediately, no proposal', executeCalls.length === 1 && tables.claire_proposals.length === 0);
  })();
}

// ======================================================================
// 3. Every real WRITE tool creates a proposal and executes NOTHING.
// ======================================================================
{
  const WRITES = ['schedule_clean','cancel_clean','move_clean','employee_day_off','move_employee','add_reminder','change_frequency','update_client_notes','edit_client','send_text','change_price','record_payment','edit_employee_hours'];
  await (async () => {
    for (const name of WRITES) {
      const { sandbox, executeCalls, tables } = buildSandbox({ role: 'owner' });
      const resStr = await sandbox._claireDispatchOrPropose({ name: name, input: { client: 'Alex Strong', employee: 'Nadia', price: '150', amount: '50', text: 'x' } }, '');
      check('WRITE tool "' + name + '" creates exactly one proposal row', tables.claire_proposals.length === 1);
      check('WRITE tool "' + name + '" never calls executeClaireToolCall on tool_use', executeCalls.length === 0);
      check('WRITE tool "' + name + '" tool_result never claims the change happened', !/done\.|saved|scheduled|cancelled|moved|sent/i.test(resStr) && /waiting for your approval/i.test(resStr));
    }
  })();
  // batch_edit_employee_hours with confirmed:true IS gated (unlike the preview call above).
  await (async () => {
    const { sandbox, executeCalls, tables } = buildSandbox({ role: 'owner' });
    await sandbox._claireDispatchOrPropose({ name: 'batch_edit_employee_hours', input: { entries: [{employee:'Nadia'}], confirmed: true } }, '');
    check('batch_edit_employee_hours confirmed:true IS gated (creates a proposal, no write)', tables.claire_proposals.length === 1 && executeCalls.length === 0);
  })();
}

// ======================================================================
// 4. Sensitive tool by a manager is refused with a plain message; owner succeeds.
// ======================================================================
{
  await (async () => {
    const { sandbox, tables } = buildSandbox({ role: 'manager' });
    const r = await sandbox._claireDispatchOrPropose({ name: 'change_price', input: { client: 'Alex Strong', price: '200' } }, '');
    check('a manager asking for a sensitive tool gets a plain refusal, not a silent failure', r === 'Only the owner or admin can do that.');
    check('a refused sensitive request creates no proposal row', tables.claire_proposals.length === 0);
  })();
  await (async () => {
    const { sandbox, tables } = buildSandbox({ role: 'dispatcher' });
    const r = await sandbox._claireDispatchOrPropose({ name: 'record_payment', input: { client: 'Alex Strong', amount: '50' } }, '');
    check('a dispatcher asking for a sensitive tool is also refused', r === 'Only the owner or admin can do that.');
  })();
  await (async () => {
    const { sandbox, tables } = buildSandbox({ role: 'owner' });
    const r = await sandbox._claireDispatchOrPropose({ name: 'change_price', input: { client: 'Alex Strong', price: '200' } }, '');
    check('an owner CAN create a sensitive proposal', tables.claire_proposals.length === 1 && tables.claire_proposals[0].risk === 'sensitive');
  })();
  await (async () => {
    const { sandbox, tables } = buildSandbox({ role: 'admin' });
    const r = await sandbox._claireDispatchOrPropose({ name: 'change_price', input: { client: 'Alex Strong', price: '200' } }, '');
    check('an admin CAN also create a sensitive proposal', tables.claire_proposals.length === 1);
  })();
}

// ======================================================================
// 5. Employee role gets no proposals (defensive fallback -- should be
//    unreachable in production since Claire never loads for an employee).
// ======================================================================
{
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'employee' });
    const r = await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Alex Strong' } }, '');
    check('an employee session asking for a non-sensitive WRITE is refused, not silently allowed', r === 'Only a manager or above can ask Claire to do that.');
    check('an employee session creates no proposal and executes nothing', tables.claire_proposals.length === 0 && executeCalls.length === 0);
  })();
}

// ======================================================================
// 6. Approve executes exactly once; a second tap does nothing (idempotent).
// ======================================================================
{
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'owner' });
    await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Alex Strong', date: '2026-11-15' } }, '');
    const id = tables.claire_proposals[0].id;
    await sandbox._claireApproveProposal(id);
    check('Approve runs the real tool exactly once', executeCalls.length === 1 && executeCalls[0].name === 'cancel_clean');
    check('the proposal is marked executed', tables.claire_proposals[0].status === 'executed');
    await sandbox._claireApproveProposal(id);
    check('a second Approve tap on the same proposal does NOT execute again', executeCalls.length === 1);
  })();
}

// schedule_clean's special-cased Approve path drives executeScheduleCmd too.
{
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'owner' });
    await sandbox._claireDispatchOrPropose({ name: 'schedule_clean', input: { client: 'Alex Strong', date: '2026-11-20', time: '09:00', team: 'B1' } }, '');
    const id = tables.claire_proposals[0].id;
    sandbox.window._pendingVoiceCmd = { client: {}, clientName: 'Alex Strong' }; // set by the real schedule_clean handler in production; simulated here since that 32-branch dispatcher isn't extracted into this sandbox
    await sandbox._claireApproveProposal(id);
    check('schedule_clean Approve drives executeScheduleCmd (the real confirm-tap equivalent)', executeCalls.some(c => c.name === '__executeScheduleCmd__'));
    check('schedule_clean proposal is marked executed', tables.claire_proposals[0].status === 'executed');
  })();
}

// A failed execution is marked failed with the error text, not silently lost.
{
  await (async () => {
    const { sandbox, tables } = buildSandbox({ role: 'owner', executeThrows: 'client not found' });
    await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Nobody' } }, '');
    const id = tables.claire_proposals[0].id;
    await sandbox._claireApproveProposal(id);
    check('a failed execution is marked failed with the real error text', tables.claire_proposals[0].status === 'failed' && tables.claire_proposals[0].error === 'client not found');
  })();
}

// ======================================================================
// 7. A stale (expired) proposal does not execute.
// ======================================================================
{
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'owner' });
    await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'Alex Strong' } }, '');
    const row = tables.claire_proposals[0];
    row.expires_at = new Date(Date.now() - 1000).toISOString(); // force expiry
    await sandbox._claireApproveProposal(row.id);
    check('an expired proposal is marked expired, not executed', row.status === 'expired');
    check('an expired proposal never calls executeClaireToolCall', executeCalls.length === 0);
  })();
}

// ======================================================================
// 8. Reject executes nothing.
// ======================================================================
{
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'owner' });
    await sandbox._claireDispatchOrPropose({ name: 'move_clean', input: { client: 'Alex Strong', to_date: '2026-11-18' } }, '');
    const id = tables.claire_proposals[0].id;
    await sandbox._claireRejectProposal(id);
    check('Reject marks the proposal rejected', tables.claire_proposals[0].status === 'rejected');
    check('Reject never executes the underlying tool', executeCalls.length === 0);
    await sandbox._claireApproveProposal(id);
    check('Approve after a Reject does nothing (status is no longer pending)', executeCalls.length === 0 && tables.claire_proposals[0].status === 'rejected');
  })();
}

// ======================================================================
// 9. Expired session: approving shows "Sign in again," never executes.
// ======================================================================
{
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'owner', sessionActive: true });
    await sandbox._claireDispatchOrPropose({ name: 'add_reminder', input: { text: 'call back' } }, '');
    const id = tables.claire_proposals[0].id;
    // Session expires AFTER the proposal was created, BEFORE Approve is tapped.
    sandbox.window.supabaseClient.auth.getSession = async function () { return { data: { session: null } }; };
    const cardBefore = sandbox.document.getElementById('claire-proposal-' + id);
    await sandbox._claireApproveProposal(id);
    check('an expired session shows "Sign in again to approve"', cardBefore._statusEl.textContent === 'Sign in again to approve.');
    check('an expired-session approve attempt never executes', executeCalls.length === 0);
    check('the proposal stays pending (not silently decided) when the session is the problem', tables.claire_proposals[0].status === 'pending');
  })();
}

// ======================================================================
// 10. Approve all -- sequential, idempotent per-item, respects the confirm.
// ======================================================================
{
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'owner', confirmReturns: false });
    await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'A' } }, '');
    await sandbox._claireDispatchOrPropose({ name: 'move_clean', input: { client: 'B' } }, '');
    const ids = tables.claire_proposals.map(r => r.id);
    await sandbox._claireApproveAllProposals(ids);
    check('declining the Approve-all confirmation executes nothing', executeCalls.length === 0);
  })();
  await (async () => {
    const { sandbox, tables, executeCalls } = buildSandbox({ role: 'owner', confirmReturns: true });
    await sandbox._claireDispatchOrPropose({ name: 'cancel_clean', input: { client: 'A' } }, '');
    await sandbox._claireDispatchOrPropose({ name: 'move_clean', input: { client: 'B' } }, '');
    const ids = tables.claire_proposals.map(r => r.id);
    await sandbox._claireApproveAllProposals(ids);
    check('confirming Approve-all executes every one of them', executeCalls.length === 2);
    check('Approve-all marks every one of them executed', tables.claire_proposals.every(r => r.status === 'executed'));
  })();
}

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
