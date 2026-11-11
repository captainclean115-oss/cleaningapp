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

// Minimal in-memory localStorage stand-in -- real Node has no
// localStorage global, and the real _claireSave/Load/ClearLocalCopy
// functions call window.localStorage.{getItem,setItem,removeItem}.
function makeFakeLocalStorage(opts) {
  const store = {};
  return {
    _store: store,
    getItem: function (k) {
      if (opts && opts.throwOnGet) throw new Error('localStorage disabled');
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem: function (k, v) {
      if (opts && opts.throwOnSet) throw new Error('localStorage disabled');
      store[k] = String(v);
    },
    removeItem: function (k) { delete store[k]; },
  };
}

function buildSandbox(opts) {
  opts = opts || {};
  const tables = opts.tables || { claire_chat_sessions: [], claire_proposals: [] };
  const fakeSb = makeFakeSupabase(tables, { forceError: opts.forceError, forceErrorTables: opts.forceErrorTables || [] });
  const bubbles = []; // { who, html }
  const introCalls = [];
  const eventListeners = {}; // { eventName: [handlers] }
  const fakeLocalStorage = opts.localStorage || makeFakeLocalStorage(opts.localStorageOpts);
  function fakeAddEventListener(name, handler) {
    (eventListeners[name] = eventListeners[name] || []).push(handler);
  }
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    window: {
      supabaseClient: fakeSb,
      confirm: function () { return opts.confirmReturns !== false; },
      localStorage: fakeLocalStorage,
      addEventListener: fakeAddEventListener,
    },
    getCurrentAppRole: function () { return opts.role || 'owner'; },
    _pentaParseAuthToken: function () { return { user: { id: opts.authUserId || 'user_1' } }; },
    document: {
      createElement: function () { return { innerHTML: '', className: '', id: '', dataset: {}, classList: { contains: function () { return false; } } }; },
      getElementById: function (id) {
        if (id === 'claire-view') return opts.claireViewEl || { classList: { contains: function () { return false; } } };
        return null;
      },
      addEventListener: fakeAddEventListener,
      hidden: false,
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
  return { sandbox: sandbox, tables: tables, bubbles: bubbles, introCalls: introCalls, localStorage: fakeLocalStorage, fireEvent: function (name) { (eventListeners[name] || []).forEach(function (h) { h(); }); } };
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

// ======================================================================
// PART 4 -- why the thread vanished: the save was fire-and-forget, so
// claire_chat_sessions stayed empty. These tests prove (1) the save is
// now genuinely awaited end-to-end, (2) a local fallback copy is
// written synchronously on every save (immune to a navigation
// cancelling the network leg), and (3) a slow/failing server read
// falls back to that local copy instead of showing nothing.
// ======================================================================

// Every real save writes a local fallback copy too, BEFORE the network
// call -- this is the actual fix for "zero rows, ever": even if the
// server leg is cancelled by a page navigation right after this turn,
// the local copy already landed synchronously.
await (async () => {
  const { sandbox, tables, localStorage } = buildSandbox({ authUserId: 'user_1', businessId: 'biz_1' });
  sandbox._claireHistory = [
    { role: 'user', content: 'cancel Pat Tuesday' },
    { role: 'assistant', content: [{ type: 'text', text: 'Proposal created.' }] },
  ];
  await sandbox._claireSaveConversationTurn();
  check('the server save succeeded (table has a row)', tables.claire_chat_sessions.length === 1);
  const raw = localStorage.getItem('claire_local_conv_biz_1_user_1');
  check('a local fallback copy is written on every successful save too', !!raw);
  const parsed = raw ? JSON.parse(raw) : null;
  check('the local copy holds the same messages', !!parsed && parsed.messages.length === 2);
})();

// Even when the SERVER leg fails outright, the local copy still lands
// (it's written before the network call, not after/instead of it).
await (async () => {
  const { sandbox, localStorage } = buildSandbox({ authUserId: 'user_1', businessId: 'biz_1', forceError: 'network down', forceErrorTables: ['claire_chat_sessions'] });
  sandbox._claireHistory = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
  await sandbox._claireSaveConversationTurn();
  check('a local fallback copy is written even when the server save fails', !!localStorage.getItem('claire_local_conv_biz_1_user_1'));
})();

// A slow/hanging server read (never resolves within the bound) falls
// back to the local copy instead of showing nothing.
await (async () => {
  const hangingTables = { claire_chat_sessions: [], claire_proposals: [] };
  const neverResolvingSb = {
    from: function (table) {
      if (table === 'claire_chat_sessions') {
        return { select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => new Promise(() => {}) }) }) }) }) };
      }
      return makeFakeSupabase(hangingTables).from(table);
    },
  };
  const { sandbox, bubbles, localStorage } = buildSandbox({ authUserId: 'user_1', businessId: 'biz_1' });
  sandbox.window.supabaseClient = neverResolvingSb;
  sandbox.window.PentaAuth.client = neverResolvingSb;
  localStorage.setItem('claire_local_conv_biz_1_user_1', JSON.stringify({
    messages: [{ role: 'user', content: 'from local fallback' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    updatedAt: new Date().toISOString(),
  }));
  await sandbox._claireOpenView();
  check('a hanging server read falls back to the local copy (bounded, not an infinite wait)', sandbox._claireHistory.length === 2);
  check('the local-fallback transcript is actually rendered', bubbles.some(b => b.html === 'from local fallback'));
})();

// A genuinely erroring server read ALSO falls back to the local copy
// (not just a timeout).
await (async () => {
  const { sandbox, bubbles, localStorage } = buildSandbox({ authUserId: 'user_1', businessId: 'biz_1', forceError: 'boom', forceErrorTables: ['claire_chat_sessions'] });
  localStorage.setItem('claire_local_conv_biz_1_user_1', JSON.stringify({
    messages: [{ role: 'user', content: 'local after server error' }],
    updatedAt: new Date().toISOString(),
  }));
  await sandbox._claireOpenView();
  check('a server error falls back to the local copy', sandbox._claireHistory.some(m => m.content === 'local after server error'));
})();

// Both the server AND the local fallback coming up empty is the ONE
// genuine-failure case that shows a visible note.
await (async () => {
  const { sandbox, bubbles } = buildSandbox({ authUserId: 'user_1', businessId: 'biz_1', forceError: 'boom', forceErrorTables: ['claire_chat_sessions'], localStorageOpts: { throwOnGet: true } });
  await sandbox._claireOpenView();
  check('server failure + no usable local copy shows a visible note (the one real-failure case)', bubbles.some(b => /could.?n.?t load|went wrong/i.test(b.html)));
})();

// A stale (>12h) local copy is not resurrected either.
await (async () => {
  const { sandbox, localStorage } = buildSandbox({ authUserId: 'user_1', businessId: 'biz_1' });
  localStorage.setItem('claire_local_conv_biz_1_user_1', JSON.stringify({
    messages: [{ role: 'user', content: 'too old' }],
    updatedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
  }));
  await sandbox._claireOpenView();
  check('a stale (>12h) local fallback copy is not loaded', sandbox._claireHistory.length === 0);
})();

// _claireHandlePageVisible: restores on pageshow/visibilitychange ONLY
// when Claire's view is active AND history is genuinely empty (the
// "iOS killed and reloaded the tab" case) -- never when content already
// survived in memory (nothing to fix, re-rendering would duplicate it).
await (async () => {
  const savedMessages = [{ role: 'user', content: 'resumed after reload' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
  const tables = { claire_chat_sessions: [
    { id: 'row_x', user_id: 'user_1', business_id: 'biz_1', messages: savedMessages, updated_at: new Date().toISOString() },
  ], claire_proposals: [] };
  const activeClaireView = { classList: { contains: function (c) { return c === 'active'; } } };
  const { sandbox, fireEvent } = buildSandbox({ authUserId: 'user_1', tables: tables, claireViewEl: activeClaireView });
  check('_claireHistory starts empty (simulating a fresh reload)', sandbox._claireHistory.length === 0);
  fireEvent('pageshow');
  // _claireOpenView is fire-and-forget from inside the handler -- give its
  // microtasks a turn.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  check('pageshow with an active Claire view + empty history restores the conversation', sandbox._claireHistory.length === savedMessages.length);
})();

await (async () => {
  const tables = { claire_chat_sessions: [
    { id: 'row_y', user_id: 'user_1', business_id: 'biz_1', messages: [{ role: 'user', content: 'should not be loaded' }], updated_at: new Date().toISOString() },
  ], claire_proposals: [] };
  const activeClaireView = { classList: { contains: function (c) { return c === 'active'; } } };
  const { sandbox, fireEvent } = buildSandbox({ authUserId: 'user_1', tables: tables, claireViewEl: activeClaireView });
  sandbox._claireHistory = [{ role: 'user', content: 'already here' }]; // state survived -- nothing lost
  fireEvent('visibilitychange');
  await new Promise((r) => setTimeout(r, 0));
  check('visibilitychange does nothing when history already has content (no duplicate re-render)', sandbox._claireHistory.length === 1 && sandbox._claireHistory[0].content === 'already here');
})();

await (async () => {
  const tables = { claire_chat_sessions: [
    { id: 'row_z', user_id: 'user_1', business_id: 'biz_1', messages: [{ role: 'user', content: 'should not be loaded either' }], updated_at: new Date().toISOString() },
  ], claire_proposals: [] };
  const inactiveClaireView = { classList: { contains: function () { return false; } } };
  const { sandbox, fireEvent } = buildSandbox({ authUserId: 'user_1', tables: tables, claireViewEl: inactiveClaireView });
  fireEvent('pageshow');
  await new Promise((r) => setTimeout(r, 0));
  check('pageshow does nothing when Claire\'s view is not even the active tab', sandbox._claireHistory.length === 0);
})();

// New chat clears the local fallback copy too -- otherwise leaving
// right after starting a new chat (before any turn writes a fresh
// local copy) would resurrect the OLD conversation next time.
await (async () => {
  const { sandbox, localStorage } = buildSandbox({ authUserId: 'user_1', businessId: 'biz_1' });
  localStorage.setItem('claire_local_conv_biz_1_user_1', JSON.stringify({ messages: [{ role: 'user', content: 'old' }], updatedAt: new Date().toISOString() }));
  sandbox._claireStartNewChat();
  check('"New chat" clears the local fallback copy', localStorage.getItem('claire_local_conv_biz_1_user_1') === null);
})();

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
