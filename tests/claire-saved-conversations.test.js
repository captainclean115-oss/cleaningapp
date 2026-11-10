// Claire safety foundation (Stage 2a) -- saved conversations tests.
//
// Extracts the REAL _claireSanitizeMessagesArray, _claireSanitizeHistoryForApi,
// _claireUserFacingError, the whole saved-conversations module
// (_claireRedactForSave, _claireTrimToLastNTurns, _claireRenderSystemNote,
// _claireSaveConversationTurn, _claireRenderHistoryTranscript,
// _claireLoadPendingProposalsIntoChat, _claireOpenView, _claireStartNewChat,
// _claireClearHistory), _claireSessionInfo/_claireIsOwnerOrAdmin, and
// _claireProposalCardHtml/_claireEscapeHtml straight out of index.html
// (not reimplementations). DOM rendering (_claireMsgsEl/_claireRenderBubble)
// and claireEnsureIntro are stubbed as async-safe spies -- this file tests
// the save/load/redact/trim logic, not chat DOM rendering.
//
// Run with: node tests/claire-saved-conversations.test.js

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

const sanitizeAndErrorSrc = extract(
  'function _claireSanitizeMessagesArray(messages) {',
  '\n\n// Best-effort durable log'
);
const sessionSrc = extract(
  'var CLAIRE_TOOL_META = {',
  'async function processVoiceCommand(text) {'
);
const savedConvSrc = extract(
  'var _claireActiveConversationId = null; // claire_chat_sessions.id once a row exists for this user',
  '\nfunction claireEnsureIntro() {'
);
const proposalCardSrc = extract(
  'function _claireEscapeHtml(s) {',
  '\n\n// Renders every card queued this turn,'
);

const COMBINED_SRC = sanitizeAndErrorSrc + '\n' + sessionSrc + '\n' + proposalCardSrc + '\n' + savedConvSrc;

// ---- in-memory fake Supabase query builder (same shape as the
// approval-gate test's fake -- duplicated per this project's convention
// of self-contained test files) --------------------------------------
function makeFakeSupabase(tables, opts) {
  opts = opts || {};
  function execQuery(state) {
    if (opts.forceError && opts.forceErrorTables.indexOf(state.table) !== -1) {
      return { data: null, error: { message: opts.forceError } };
    }
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
      if (!obj.updated_at) obj.updated_at = obj.created_at;
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
    if (state.single) {
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows (single)' } };
    }
    if (state.maybeSingle) {
      return { data: rows[0] || null, error: null };
    }
    return { data: rows, error: null };
  }
  function builder(table) {
    const state = { table: table, filters: [], op: null, payload: null, single: false, maybeSingle: false, order: null, limit: null };
    const b = {
      insert: function (obj) { state.op = 'insert'; state.payload = obj; return b; },
      update: function (obj) { state.op = 'update'; state.payload = obj; return b; },
      delete: function () { state.op = 'delete'; return b; },
      select: function () { if (!state.op) state.op = 'select'; return b; },
      eq: function (k, v) { state.filters.push([k, v]); return b; },
      order: function (col, o) { state.order = [col, o]; return b; },
      limit: function (n) { state.limit = n; return b; },
      single: function () { state.single = true; return Promise.resolve(execQuery(state)); },
      maybeSingle: function () { state.maybeSingle = true; return Promise.resolve(execQuery(state)); },
      then: function (resolve, reject) { return Promise.resolve(execQuery(state)).then(resolve, reject); },
    };
    return b;
  }
  return { from: function (table) { return builder(table); } };
}

function buildSandbox(opts) {
  opts = opts || {};
  const tables = opts.tables || { claire_chat_sessions: [], claire_proposals: [] };
  const fakeSb = makeFakeSupabase(tables, { forceError: opts.forceError, forceErrorTables: opts.forceErrorTables || [] });
  const bubbles = []; // { who, html }
  const systemNotes = [];
  const introCalls = [];
  const sandbox = {
    console: console,
    window: {
      supabaseClient: fakeSb,
      confirm: function () { return opts.confirmReturns !== false; },
    },
    getCurrentAppRole: function () { return opts.role || 'owner'; },
    _pentaParseAuthToken: function () { return { user: { id: opts.authUserId || 'user_1' } }; },
    document: {
      createElement: function () { return { innerHTML: '', className: '', id: '', dataset: {} }; },
    },
    // _claireRenderSystemNote (a real, extracted function) builds its own
    // DOM node via document.createElement then appends it to _claireMsgsEl()'s
    // box -- routed into the same `bubbles` array _claireRenderBubble uses so
    // both are inspectable the same way.
    _claireMsgsEl: function () {
      return {
        dataset: {}, scrollTop: 0, scrollHeight: 0,
        appendChild: function (el) { bubbles.push({ who: 'system', html: el.innerHTML }); },
      };
    },
    _claireRenderBubble: function (who, html) { bubbles.push({ who: who, html: html }); },
    claireEnsureIntro: function () { introCalls.push(1); },
    _claireHistory: [],
  };
  sandbox.window.PentaAuth = { client: fakeSb };
  sandbox.window.PentaTenant = { current: function () { return opts.businessId || 'biz_1'; } };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return { sandbox: sandbox, tables: tables, bubbles: bubbles, introCalls: introCalls };
}

async function main() {

// ======================================================================
// Dangling tool_use is never persisted -- _claireSaveConversationTurn
// runs the full sanitize pass before writing, so even a defensively-bad
// _claireHistory (a trailing tool_use with no tool_result) never reaches
// the saved row with the dangling entry intact.
// ======================================================================
await (async () => {
  const { sandbox, tables } = buildSandbox({});
  sandbox._claireHistory = [
    { role: 'user', content: 'cancel Pat Tuesday' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'cancel_clean', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Proposal created.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_DANGLING', name: 'move_clean', input: {} }] }, // no matching tool_result
  ];
  await sandbox._claireSaveConversationTurn();
  const saved = tables.claire_chat_sessions[0];
  const hasDangling = saved.messages.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.id === 'toolu_DANGLING'));
  check('a dangling tool_use (no tool_result) is never written into the saved row', !hasDangling);
  check('the well-paired turn before it is still saved', saved.messages.some(m => m.role === 'user' && m.content === 'cancel Pat Tuesday'));
})();

// ======================================================================
// Sensitive tool results are omitted from the saved row.
// ======================================================================
await (async () => {
  const { sandbox, tables } = buildSandbox({});
  sandbox._claireHistory = [
    { role: 'user', content: 'what does Alex owe, and set her price to 200' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bal', name: 'lookup_balance', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bal', content: 'Alex Strong has a balance of $340.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_price', name: 'change_price', input: { client: 'Alex Strong', price: '200' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_price', content: 'Proposal created for "Change Alex Strong\'s price to $200." -- waiting for your approval.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_lookup', name: 'lookup_client', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_lookup', content: 'Alex Strong -- 12 Main St.' }] },
  ];
  await sandbox._claireSaveConversationTurn();
  const saved = tables.claire_chat_sessions[0];
  function resultFor(toolUseId) {
    for (const m of saved.messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === 'tool_result' && b.tool_use_id === toolUseId) return b.content;
      }
    }
    return undefined;
  }
  check('lookup_balance tool_result is redacted before saving', resultFor('toolu_bal') === '[omitted from saved history]');
  check('change_price (sensitive) tool_result is redacted before saving', resultFor('toolu_price') === '[omitted from saved history]');
  check('a non-sensitive lookup_client tool_result is kept as-is', resultFor('toolu_lookup') === 'Alex Strong -- 12 Main St.');
  check('the balance amount ($340) never appears anywhere in the saved row', JSON.stringify(saved.messages).indexOf('340') === -1);
})();

// ======================================================================
// Turn-boundary trim keeps only the last N turns, never a raw array slice.
// ======================================================================
await (async () => {
  const { sandbox } = buildSandbox({});
  const messages = [];
  for (let t = 1; t <= 25; t++) {
    messages.push({ role: 'user', content: 'turn ' + t });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'reply ' + t }] });
  }
  const trimmed = sandbox._claireTrimToLastNTurns(messages, 20);
  const firstUserMsg = trimmed.find(m => m.role === 'user');
  check('trimming to the last 20 turns keeps exactly the last 20 user turns', trimmed.filter(m => m.role === 'user' && typeof m.content === 'string').length === 20);
  check('the trim starts exactly on a turn boundary (turn 6), never mid-turn', firstUserMsg.content === 'turn 6');
  check('fewer than N turns total is returned untouched', sandbox._claireTrimToLastNTurns(messages.slice(0, 6), 20).length === 6);
})();

// ======================================================================
// Save failure shows a visible note but never blocks Claire (never throws).
// ======================================================================
await (async () => {
  const { sandbox, bubbles } = buildSandbox({ forceError: 'network down', forceErrorTables: ['claire_chat_sessions'] });
  sandbox._claireHistory = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
  let threw = false;
  try { await sandbox._claireSaveConversationTurn(); } catch (e) { threw = true; }
  check('a save failure never throws / never blocks Claire', !threw);
  check('a save failure shows a small visible note', bubbles.some(b => /could not save/i.test(b.html)));
})();

// ======================================================================
// Clear history only touches the current user's rows.
// ======================================================================
await (async () => {
  const tables = { claire_chat_sessions: [
    { id: 'row_me', user_id: 'user_1', business_id: 'biz_1', messages: [] },
    { id: 'row_other', user_id: 'user_2', business_id: 'biz_1', messages: [] },
  ], claire_proposals: [] };
  const { sandbox } = buildSandbox({ authUserId: 'user_1', tables: tables, confirmReturns: true });
  await sandbox._claireClearHistory();
  check('Clear history deletes only the current user\'s row', tables.claire_chat_sessions.length === 1 && tables.claire_chat_sessions[0].id === 'row_other');
})();

await (async () => {
  const tables = { claire_chat_sessions: [{ id: 'row_me', user_id: 'user_1', business_id: 'biz_1', messages: [] }], claire_proposals: [] };
  const { sandbox } = buildSandbox({ authUserId: 'user_1', tables: tables, confirmReturns: false });
  await sandbox._claireClearHistory();
  check('declining the Clear-history confirmation deletes nothing', tables.claire_chat_sessions.length === 1);
})();

// ======================================================================
// Load-on-open: most recent conversation loads and replays as a transcript.
// ======================================================================
await (async () => {
  const savedMessages = [
    { role: 'user', content: 'cancel Pat Tuesday' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'cancel_clean', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Proposal created.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I have a proposal for your approval.' }] },
  ];
  const tables = { claire_chat_sessions: [
    { id: 'row_recent', user_id: 'user_1', business_id: 'biz_1', messages: savedMessages, updated_at: new Date().toISOString() },
  ], claire_proposals: [] };
  const { sandbox, bubbles } = buildSandbox({ authUserId: 'user_1', tables: tables });
  await sandbox._claireOpenView();
  check('opening Claire loads the most recent conversation into _claireHistory', sandbox._claireHistory.length === savedMessages.length);
  check('opening Claire replays the visible transcript (user + text turns only)', bubbles.some(b => b.who === 'user' && b.html === 'cancel Pat Tuesday') && bubbles.some(b => b.who === 'claire' && b.html === 'I have a proposal for your approval.'));
})();

// A stale (>12h) conversation is NOT loaded -- fresh start instead.
await (async () => {
  const staleMessages = [{ role: 'user', content: 'old message' }];
  const tables = { claire_chat_sessions: [
    { id: 'row_stale', user_id: 'user_1', business_id: 'biz_1', messages: staleMessages, updated_at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() },
  ], claire_proposals: [] };
  const { sandbox, introCalls } = buildSandbox({ authUserId: 'user_1', tables: tables });
  await sandbox._claireOpenView();
  check('a conversation older than 12h is not loaded', sandbox._claireHistory.length === 0);
})();

// An unrepairable loaded conversation starts fresh with a visible note.
await (async () => {
  // Every message here is an orphaned tool_result with nothing before it --
  // _claireSanitizeMessagesArray drops all of them, leaving nothing.
  const unrepairable = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan_1', content: 'x' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan_2', content: 'y' }] },
  ];
  const tables = { claire_chat_sessions: [
    { id: 'row_broken', user_id: 'user_1', business_id: 'biz_1', messages: unrepairable, updated_at: new Date().toISOString() },
  ], claire_proposals: [] };
  const { sandbox, bubbles } = buildSandbox({ authUserId: 'user_1', tables: tables });
  await sandbox._claireOpenView();
  check('a genuinely unrepairable loaded conversation starts fresh (empty history)', sandbox._claireHistory.length === 0);
  check('a genuinely unrepairable loaded conversation shows "Started a new conversation"', bubbles.some(b => /started a new conversation/i.test(b.html)));
})();

// A loaded conversation with ONE orphaned tool_result (among otherwise
// valid turns) is repaired -- the orphan is dropped, the rest survives.
await (async () => {
  const partiallyBroken = [
    { role: 'user', content: 'first real turn' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'stray, no preceding tool_use' }] },
    { role: 'user', content: 'second real turn' },
    { role: 'assistant', content: [{ type: 'text', text: 'got it' }] },
  ];
  const tables = { claire_chat_sessions: [
    { id: 'row_partial', user_id: 'user_1', business_id: 'biz_1', messages: partiallyBroken, updated_at: new Date().toISOString() },
  ], claire_proposals: [] };
  const { sandbox, bubbles } = buildSandbox({ authUserId: 'user_1', tables: tables });
  await sandbox._claireOpenView();
  check('a loaded conversation with one orphaned tool_result is repaired, not discarded wholesale', sandbox._claireHistory.length > 0);
  check('the orphaned tool_result itself is dropped', !sandbox._claireHistory.some(m => Array.isArray(m.content) && m.content.some(b => b.tool_use_id === 'toolu_orphan')));
  check('both real turns survive the repair', bubbles.some(b => b.html === 'first real turn') && bubbles.some(b => b.html === 'second real turn'));
})();

// Pending proposals load into the chat on open too.
await (async () => {
  const tables = { claire_chat_sessions: [], claire_proposals: [
    { id: 'prop_1', business_id: 'biz_1', status: 'pending', risk: 'normal', summary: 'Cancel Alex Strong\'s clean.', created_at: new Date().toISOString() },
  ] };
  const { sandbox, bubbles } = buildSandbox({ authUserId: 'user_1', tables: tables });
  await sandbox._claireOpenView();
  check('a pending proposal renders a card on open (survives reload)', bubbles.some(b => b.html.indexOf('Cancel Alex Strong') !== -1));
})();

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
