// Claire approval-gate bypass fix.
//
// BUG (reported by Tom): "cancel [a clean] for today" cancelled the job
// immediately with no proposal card and no Approve step. Root cause:
// processVoiceCommandLocal (the fallback that runs whenever the Claude
// API call fails -- its two call sites are in processVoiceCommand's
// catch blocks) parsed "cancel"/"schedule"/"day off"/"reminder" phrases
// with its OWN regex logic and wrote DIRECTLY (job.cancelled=true +
// _pentaJobWrite, dailyAssignments + PentaAssignments.assign,
// manualTasks, or a same-page Yes/No panel -> executeScheduleCmd) --
// none of it ever went through _claireDispatchOrPropose, the gate PR
// #219 added. The gate only ever covered the API-driven path; this
// offline/degraded fallback path was free to execute immediately.
//
// This file extracts the REAL processVoiceCommandLocal, parseScheduleCommand,
// and the full approval-gate module (CLAIRE_TOOL_META/_claireToolMeta/
// _claireSessionInfo/_claireDispatchOrPropose/_claireApproveProposal/etc.)
// straight out of index.html and drives the EXACT phrases from the bug
// report through the fallback path end to end: phrase in, assert zero
// job/assignment/task writes happen before Approve, then Approve, then
// assert exactly one write happens.
//
// Scope note: processVoiceCommandLocal (extracted here) IS "the API-
// failure fallback path" -- it is only ever invoked from
// processVoiceCommand's two catch blocks when the Claude API call
// throws. Re-extracting the much larger processVoiceCommand (system
// prompt assembly, the live tool-use loop) to additionally prove THOSE
// two call sites route here unchanged is unnecessary: they are two
// unconditional `processVoiceCommandLocal(text, ...)` calls with no
// write logic of their own, confirmed by direct reading at both sites.
//
// Run with: node tests/claire-gate-bypass-fix.test.js

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

const localFallbackSrc = extract(
  'function _claireOfflineClientResult(lower, text, apiErrorReason) {',
  '\nfunction cancelVoiceCmd() {'
);
const parseSrc = extract(
  'function parseScheduleCommand(lower, original) {',
  '\n\n// v9.5.2: clientExtras'
);
const toolMetaSrc = extract(
  'var CLAIRE_TOOL_META = {',
  'async function processVoiceCommand(text) {'
);
const gateSrc = extract(
  'var _clairePendingProposals = []; // { id, html, sensitive }',
  '\n\n// When a pending action (schedule/invoice/SMS) is later confirmed by Tom'
);

const COMBINED_SRC = localFallbackSrc + '\n' + parseSrc + '\n' + toolMetaSrc + '\n' + gateSrc;

// ---- in-memory fake Supabase query builder (same shape used in the
// other Claire test files -- duplicated per this project's convention
// of self-contained test files) --------------------------------------
function makeFakeSupabase(tables) {
  function execQuery(state) {
    let rows = (tables[state.table] || []).slice();
    state.filters.forEach((f) => { rows = rows.filter((r) => r[f[0]] === f[1]); });
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
  return {
    from: (table) => builder(table),
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  };
}

function buildSandbox(opts) {
  opts = opts || {};
  const tables = { claire_proposals: [] };
  const fakeSb = makeFakeSupabase(tables);
  const jobWrites = [];       // _pentaJobWrite calls -- the real job-cancel/move/schedule write path
  const assignmentWrites = []; // PentaAssignments.assign calls -- the real day-off write path
  const taskWrites = [];      // manualTasks pushes -- the real reminder write path
  const scheduleCmdCalls = []; // executeScheduleCmd calls -- the real schedule-confirm write path
  const replies = [];
  const jobs = opts.jobs || [];
  const manualTasks = [];
  const cards = {};
  function makeCard(id) {
    const statusEl = { textContent: '' };
    return { querySelector: (sel) => (sel === '.claire-proposal-status' ? statusEl : null), querySelectorAll: () => [], _statusEl: statusEl };
  }
  const sandbox = {
    console,
    window: { supabaseClient: fakeSb, confirm: () => true, _pendingVoiceCmd: null, PentaTenant: { current: () => 'biz_1' } },
    document: {
      getElementById: (id) => {
        if (id === 'voice-cmd-status') return { innerHTML: '', style: {} };
        if (id.indexOf('claire-proposal-') === 0) {
          const pid = id.slice('claire-proposal-'.length);
          if (!cards[pid]) cards[pid] = makeCard(pid);
          return cards[pid];
        }
        return null;
      },
    },
    getCurrentAppRole: () => opts.role || 'owner',
    _pentaParseAuthToken: () => ({ user: { id: 'user_1' } }),
    isManagerRole: () => true,
    PentaClients: {
      forEachClient: (cb) => { (opts.clients || [{ id: 'c1', fn: 'Alex', ln: 'Strong' }]).forEach(cb); },
    },
    EMPLOYEE_ROSTER: opts.employeeRoster || [{ id: 'e1', name: 'Nadia' }],
    PentaEmployees: null,
    PentaAssignments: { assign: async (dk, status, empId) => { assignmentWrites.push({ dk, status, empId }); return { ok: true }; } },
    jobs: jobs,
    dateKey: (d) => d.toISOString().slice(0, 10),
    saveJobs: () => {},
    saveDailyAssignments: () => {},
    dailyAssignments: {},
    manualTasks: manualTasks,
    saveManualTasks: () => {},
    renderTasks: () => {},
    logPendingUpdate: () => {},
    renderCal: () => {},
    _pentaTeamColor: () => '#000',
    claireReply: (msg) => { replies.push(msg); },
    _claireRenderBubble: () => {},
    _pentaJobWrite: async (op, args) => { jobWrites.push({ op, args }); return { ok: true }; },
    executeClaireToolCall: async (toolCall) => {
      // Stub for the Approve path: performs the REAL write for the
      // tools this test exercises (cancel/schedule/day-off/reminder),
      // mirroring what _executeClaireToolCallInner actually does, so
      // the "exactly one write after Approve" assertion is meaningful.
      if (toolCall.name === 'cancel_clean') {
        const job = jobs.find((j) => !j.cancelled);
        if (job) { job.cancelled = true; }
        await sandbox._pentaJobWrite('update', { id: job && job.id, patch: { cancelled: true } });
        return 'Cancelled. Done.';
      }
      if (toolCall.name === 'employee_day_off') {
        await sandbox.PentaAssignments.assign(toolCall.input.date, 'OFF', 'e1');
        return 'Marked off. Done.';
      }
      if (toolCall.name === 'add_reminder') {
        manualTasks.unshift({ text: toolCall.input.text });
        return 'Noted. Done.';
      }
      return 'Executed ' + toolCall.name + '.';
    },
    executeScheduleCmd: async () => { scheduleCmdCalls.push(1); },
  };
  vm.createContext(sandbox);
  vm.runInContext(COMBINED_SRC, sandbox);
  return { sandbox, tables, jobWrites, assignmentWrites, taskWrites: manualTasks, scheduleCmdCalls, replies, jobs };
}

async function main() {

// ======================================================================
// 1. "cancel the Alex Strong clean for today" -- the exact bug report shape.
// ======================================================================
await (async () => {
  const jobs = [{ id: 'job1', clientId: 'c1', clientName: 'Strong, Alex', date: new Date().toISOString().slice(0, 10), cancelled: false }];
  const { sandbox, tables, jobWrites, replies } = buildSandbox({ jobs });
  await sandbox.processVoiceCommandLocal('cancel the Alex Strong clean for today', 'API unavailable');
  check('"cancel the <client> clean for today" creates a proposal, not a direct write', tables.claire_proposals.length === 1);
  check('"cancel the <client> clean for today" never calls _pentaJobWrite before Approve', jobWrites.length === 0);
  check('the job itself is untouched before Approve', jobs[0].cancelled === false);
  check('Claire\'s reply does not claim the clean is cancelled', !/cancelled|done!/i.test(replies[replies.length - 1] || '') );

  const proposalId = tables.claire_proposals[0].id;
  await sandbox._claireApproveProposal(proposalId);
  check('Approve results in exactly one _pentaJobWrite call', jobWrites.length === 1);
  check('the job is cancelled only after Approve', jobs[0].cancelled === true);
  check('the proposal is marked executed', tables.claire_proposals[0].status === 'executed');
})();

// ======================================================================
// 2. "cancel with me for today" -- no resolvable client; must not write
//    and must not even create a proposal (nothing to propose). Claire
//    auth-refresh fix: this function only ever runs because the real
//    API call already failed, so it must NEVER claim a job doesn't
//    exist (a false, specific-sounding diagnosis) when the real
//    problem is the dead connection -- it now surfaces the real,
//    honest apiErrorReason instead of "couldn't find that job."
// ======================================================================
await (async () => {
  const jobs = [{ id: 'job1', clientId: 'c1', clientName: 'Strong, Alex', date: new Date().toISOString().slice(0, 10), cancelled: false }];
  const { sandbox, tables, jobWrites, replies } = buildSandbox({ jobs });
  await sandbox.processVoiceCommandLocal('cancel with me for today', 'API unavailable');
  check('an unresolvable "cancel" phrase creates no proposal', tables.claire_proposals.length === 0);
  check('an unresolvable "cancel" phrase performs no write', jobWrites.length === 0);
  check('an unresolvable "cancel" phrase surfaces the REAL reason (the dead connection), never a false "job not found" claim', replies[replies.length - 1] === 'API unavailable');
})();

// ======================================================================
// 3. "schedule Alex Strong Thursday 9am B1" -- the old code showed its
//    OWN Yes/No panel and wrote via executeScheduleCmd with no gate.
// ======================================================================
await (async () => {
  const { sandbox, tables, scheduleCmdCalls, replies } = buildSandbox({});
  await sandbox.processVoiceCommandLocal('schedule Alex Strong Thursday 9am B1', 'API unavailable');
  check('"schedule X" creates a proposal, not the old same-page Yes/No panel', tables.claire_proposals.length === 1);
  check('"schedule X" never drives executeScheduleCmd before Approve', scheduleCmdCalls.length === 0);
  check('"schedule X" sets no window._pendingVoiceCmd before Approve (old bypass panel is gone)', !sandbox.window._pendingVoiceCmd);

  const proposalId = tables.claire_proposals[0].id;
  // Approve's existing scheduleSpecial handling needs _pendingVoiceCmd set
  // (normally done by the real schedule_clean branch inside
  // _executeClaireToolCallInner, which this test's executeClaireToolCall
  // stub does not reimplement) -- simulate that one side effect here,
  // matching exactly how tests/claire-approval-gate.test.js already
  // covers this same Approve path.
  sandbox.window._pendingVoiceCmd = { client: {}, clientName: 'Alex Strong' };
  await sandbox._claireApproveProposal(proposalId);
  check('Approve drives executeScheduleCmd exactly once', scheduleCmdCalls.length === 1);
  check('the proposal is marked executed', tables.claire_proposals[0].status === 'executed');
})();

// ======================================================================
// 4. "move Alex Strong to Thursday" -- processVoiceCommandLocal has NO
//    "move" branch at all (never implemented here), so it must fall
//    through to the generic, non-committal reply -- never a write, and
//    never a false "done" claim.
// ======================================================================
await (async () => {
  const jobs = [{ id: 'job1', clientId: 'c1', clientName: 'Strong, Alex', date: new Date().toISOString().slice(0, 10), cancelled: false }];
  const { sandbox, tables, jobWrites, replies } = buildSandbox({ jobs });
  await sandbox.processVoiceCommandLocal('move Alex Strong to Thursday', 'API unavailable');
  check('"move X to Thursday" has no local-fallback write path at all (by design -- not a bypass)', jobWrites.length === 0 && tables.claire_proposals.length === 0);
  check('"move X to Thursday" gets the honest generic fallback (includes the passed-in error reason), not a false success', (replies[replies.length - 1] || '').indexOf('API unavailable') === 0);
})();

// ======================================================================
// 5. Day off: "Nadia day off today" -- old code wrote dailyAssignments +
//    PentaAssignments.assign directly with no gate.
// ======================================================================
await (async () => {
  const { sandbox, tables, assignmentWrites, replies } = buildSandbox({});
  await sandbox.processVoiceCommandLocal('Nadia day off today', 'API unavailable');
  check('"X day off today" creates a proposal, not a direct assignment write', tables.claire_proposals.length === 1);
  check('"X day off today" never calls PentaAssignments.assign before Approve', assignmentWrites.length === 0);

  const proposalId = tables.claire_proposals[0].id;
  await sandbox._claireApproveProposal(proposalId);
  check('Approve results in exactly one assignment write', assignmentWrites.length === 1);
  check('the proposal is marked executed', tables.claire_proposals[0].status === 'executed');
})();

// ======================================================================
// 6. Reminder: "remind me to call the vendor" -- old code pushed to
//    manualTasks directly with no gate.
// ======================================================================
await (async () => {
  const { sandbox, tables, taskWrites, replies } = buildSandbox({});
  await sandbox.processVoiceCommandLocal('remind me to call the vendor', 'API unavailable');
  check('"remind me to X" creates a proposal, not a direct task write', tables.claire_proposals.length === 1);
  check('"remind me to X" never writes to manualTasks before Approve', taskWrites.length === 0);

  const proposalId = tables.claire_proposals[0].id;
  await sandbox._claireApproveProposal(proposalId);
  check('Approve results in exactly one manualTasks write', taskWrites.length === 1);
})();

// ======================================================================
// 7. Sensitive tools have no local-fallback branch at all (change_price,
//    record_payment, edit_employee_hours are not parseable phrases here)
//    -- confirms the local parser can't be used to route around the
//    owner/admin sensitive check either, since it can't reach those
//    tools at all.
// ======================================================================
await (async () => {
  const { sandbox, tables, jobWrites, replies } = buildSandbox({ role: 'manager' });
  await sandbox.processVoiceCommandLocal('change Alex Strong price to 200', 'API unavailable');
  check('a sensitive-tool phrase has no local-fallback branch -- falls to the generic honest reply', tables.claire_proposals.length === 0 && jobWrites.length === 0);
})();

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
