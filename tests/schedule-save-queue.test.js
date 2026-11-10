// Schedule Save Queue (schedule-save-queue branch). Fixes the silent
// data-loss risk: every job-write path pushed the optimistic local
// change first, then called PentaJobs without awaiting it -- a server
// failure was only console.warn'd, and a later PentaJobs cache mirror
// could silently wipe a never-synced local job out of `jobs[]`
// entirely. Extracts the real _pentaJobWrite/_scheduleSave* module,
// the real PentaJobs facade, the real mirror (_enrichJobFromCache +
// _mirrorPentaJobsToInMemory), and _generateUuidV4 verbatim from
// index.html. The fake Supabase stand-in is ASYNC throughout (lesson
// from the missing-await bug on the visit-snapshots-await-fix branch).
//
// Run with: node tests/schedule-save-queue.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const uuidSource = extract('function _generateUuidV4() {', '\n\nasync function submitApplication', '_generateUuidV4');
const pentaJobsSource = extract('window.PentaJobs = (function() {', '// SCHEDULE SAVE QUEUE', 'PentaJobs facade');
const queueSource = extract('var SCHEDULE_SAVE_RETRY_INTERVAL_MS = 60000;', '(function pentaPrimeJobs', 'Schedule Save Queue module');
const mirrorSource = extract('function _enrichJobFromCache(row) {', '(function pentaPhase4MirrorHydrate', 'mirror functions');

const fnSource = [uuidSource, pentaJobsSource, queueSource, mirrorSource].join('\n');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ── Fake Supabase for the `jobs` table. ASYNC throughout -- every
// builder method that ends a chain returns a real Promise, and the
// builder itself is also thenable so a bare `await sb.from(...).x()`
// (no trailing .select().maybeSingle()) works too, matching every
// real call shape PentaJobs itself uses. ──
function makeFakeJobsSupabase(opts) {
  opts = opts || {};
  const rows = opts.rows || {};           // id -> row (already DB-shaped)
  const failQueue = opts.failQueue || []; // booleans, shifted one per call; true = simulate a thrown network failure
  function maybeFail() {
    if (failQueue.length) { const f = failQueue.shift(); if (f) throw new Error('simulated network failure'); }
  }
  return {
    _rows: rows,
    from: function (table) {
      const state = { filters: [], single: false };
      function matches(row) { return state.filters.every(function (f) { return row[f[0]] === f[1]; }); }
      function runOp() {
        if (state.op === 'insert' || state.op === 'upsert') {
          const out = [];
          state.payload.forEach(function (r) {
            const id = r.id || ('server-' + Math.random().toString(36).slice(2));
            const merged = Object.assign({ id: id }, rows[id] || {}, r);
            rows[id] = merged;
            out.push(merged);
          });
          return { data: state.single ? (out[0] || null) : out, error: null };
        }
        if (state.op === 'update') {
          const matched = Object.keys(rows).map(function (k) { return rows[k]; }).filter(matches);
          matched.forEach(function (r) { Object.assign(r, state.payload); });
          return { data: state.single ? (matched[0] || null) : matched, error: null };
        }
        if (state.op === 'delete') {
          const toDelete = Object.keys(rows).map(function (k) { return rows[k]; }).filter(matches);
          toDelete.forEach(function (r) { delete rows[r.id]; });
          return { data: null, error: null };
        }
        return { data: null, error: new Error('FakeJobsSupabase: unsupported op ' + state.op) };
      }
      const builder = {
        insert: function (row) { state.op = 'insert'; state.payload = Array.isArray(row) ? row : [row]; return builder; },
        upsert: function (row) { state.op = 'upsert'; state.payload = Array.isArray(row) ? row : [row]; return builder; },
        update: function (patch) { state.op = 'update'; state.payload = patch; return builder; },
        delete: function () { state.op = 'delete'; return builder; },
        select: function () { return builder; },
        range: function () { return builder; },
        order: function () { return builder; },
        eq: function (col, val) { state.filters.push([col, val]); return builder; },
        maybeSingle: function () { state.single = true; return (async function () { maybeFail(); return runOp(); })(); },
        then: function (resolve, reject) { (async function () { try { maybeFail(); resolve(runOp()); } catch (e) { reject(e); } })(); }
      };
      return builder;
    },
    auth: {
      getUser: function () { return Promise.resolve({ data: { user: { id: 'auth-1' } } }); },
      getSession: function () { return Promise.resolve(opts.noSession ? { data: { session: null } } : { data: { session: { access_token: 'x' } } }); }
    }
  };
}

function buildSandbox(opts) {
  opts = opts || {};
  const fakeSb = opts.fakeSupabase || makeFakeJobsSupabase(opts);
  const documentStubs = Object.assign({
    'penta-login-screen': { style: { display: opts.locked ? 'flex' : 'none' } }
  }, opts.documentIds || {});
  const sandbox = {
    console: console,
    window: {
      addEventListener: function () {},
      supabaseClient: fakeSb,
      PentaEmployees: { listSync: function () { return [{ business_id: opts.bid || 'biz-1' }]; } },
      PentaTenant: { current: function () { return opts.bid || 'biz-1'; } }
    },
    document: {
      body: { classList: { contains: function (c) { return c === 'in-portal' && !!opts.inPortal; } } },
      getElementById: function (id) { return documentStubs[id] || null; },
      querySelectorAll: function () { return []; },
      addEventListener: function () {}
    },
    localStorage: (function () {
      const store = opts.localStorageSeed ? Object.assign({}, opts.localStorageSeed) : {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function (k, v) { store[k] = String(v); },
        removeItem: function (k) { delete store[k]; },
        _store: store
      };
    })(),
    getCurrentAppRole: function () { return opts.role !== undefined ? opts.role : 'owner'; },
    showToast: opts.showToastFn || function () {},
    saveJobs: opts.saveJobsFn || function () {},
    renderCal: function () {},
    jobs: opts.jobs || [],
    crypto: (typeof crypto !== 'undefined') ? crypto : undefined,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, fakeSb: fakeSb };
}

async function main() {
  // ── 1. Success clears the queue (nothing was ever queued) ──
  {
    const { sandbox } = buildSandbox({ bid: 'biz-1' });
    const jobId = sandbox._generateUuidV4();
    const res = await sandbox._pentaJobWrite('insert', { job: { id: jobId, client_id: 'c1', date: '2026-11-01' } });
    check('insert succeeds', res.ok, true);
    check('queue stays empty on success', sandbox._scheduleSaveQueue.length, 0);
  }

  // ── 2. Failure queues the entry and shows the pill (slot rendered) ──
  {
    let toastMsgs = [];
    const { sandbox } = buildSandbox({ bid: 'biz-1', failQueue: [true], showToastFn: function (m) { toastMsgs.push(m); } });
    const jobId = sandbox._generateUuidV4();
    const res = await sandbox._pentaJobWrite('insert', { job: { id: jobId, client_id: 'c1', date: '2026-11-01' } });
    check('insert reports queued', res.queued, true);
    check('one entry queued', sandbox._scheduleSaveQueue.length, 1);
    check('queued entry is the right job', sandbox._scheduleSaveQueue[0].jobId, jobId);
    checkTrue('a visible message was shown (never console-only)', toastMsgs.some(function (m) { return /kept on this device/.test(m); }));
  }

  // ── 3. Reload re-applies queued jobs; server data does not overwrite them ──
  {
    const { sandbox } = buildSandbox({ bid: 'biz-1' });
    const queuedJob = { id: sandbox._generateUuidV4(), clientId: 'c9', date: '2026-11-05', team: 'B1' };
    sandbox._scheduleSaveQueueBid = 'biz-1';
    sandbox._scheduleSaveQueue = [{ queueId: 'q1', op: 'insert', jobId: queuedJob.id, payload: { job: queuedJob }, attempts: 0, lastError: 'offline', queuedAt: new Date().toISOString() }];
    // Server's own fresh list has a DIFFERENT, unrelated job -- the
    // queued-but-unsynced one must still show up after the mirror.
    const freshFromServer = [{ id: 'server-job-1', clientId: 'c1', date: '2026-11-01', team: 'B1' }];
    const merged = sandbox._scheduleSaveReapplyOntoFresh(freshFromServer);
    check('fresh server job still present', merged.some(function (j) { return j.id === 'server-job-1'; }), true);
    check('queued unsynced job re-applied on top, not lost', merged.some(function (j) { return j.id === queuedJob.id; }), true);
    check('nothing duplicated', merged.length, 2);
  }

  // ── 3b. The same, through the real mirror function end-to-end ──
  {
    const { sandbox, fakeSb } = buildSandbox({ bid: 'biz-1' });
    sandbox.jobs = [];
    sandbox.window.PentaJobs = {
      isReady: function () { return true; },
      listSync: function () { return [{ id: 'server-job-2', client_id: 'c2', date: '2026-11-02', team: 'B1' }].map(function(r){ return { id: r.id, clientId: r.client_id, date: r.date, team: r.team }; }); }
    };
    const queuedId = sandbox._generateUuidV4();
    sandbox._scheduleSaveQueueBid = 'biz-1';
    sandbox._scheduleSaveQueue = [{ queueId: 'q2', op: 'insert', jobId: queuedId, payload: { job: { id: queuedId, clientId: 'c3', date: '2026-11-03' } }, attempts: 0, lastError: 'offline', queuedAt: new Date().toISOString() }];
    sandbox._mirrorPentaJobsToInMemory();
    check('mirror keeps the server job', sandbox.jobs.some(function (j) { return j.id === 'server-job-2'; }), true);
    check('mirror never wipes the queued unsynced job', sandbox.jobs.some(function (j) { return j.id === queuedId; }), true);
  }

  // ── 4. Retry success causes no duplicate insert (upsert-on-conflict) ──
  {
    const rows = {};
    const fakeSb = makeFakeJobsSupabase({ rows: rows, failQueue: [true, false] }); // first attempt fails, retry succeeds
    const { sandbox } = buildSandbox({ bid: 'biz-1', fakeSupabase: fakeSb });
    const jobId = sandbox._generateUuidV4();
    const args = { job: { id: jobId, client_id: 'c1', date: '2026-11-01' } };
    const r1 = await sandbox._pentaJobWrite('insert', args);
    check('first attempt queued (simulated failure)', r1.queued, true);
    const queued = sandbox._scheduleSaveQueue[0];
    const r2 = await sandbox._pentaJobWrite('insert', Object.assign({}, queued.payload, { queueId: queued.queueId }));
    check('retry succeeds', r2.ok, true);
    check('queue cleared after retry success', sandbox._scheduleSaveQueue.length, 0);
    check('exactly one row exists server-side (no duplicate)', Object.keys(rows).length, 1);
  }

  // ── 5. Delete of an already-gone row counts as success ──
  {
    const { sandbox } = buildSandbox({ bid: 'biz-1', rows: {} }); // row never existed / already deleted
    const someId = '11111111-1111-1111-1111-111111111111';
    const res = await sandbox._pentaJobWrite('remove', { id: someId });
    check('remove of an already-gone row is ok (not an error)', res.ok, true);
    check('nothing queued for an already-gone delete', sandbox._scheduleSaveQueue.length, 0);
  }

  // ── 6. Edit of a server-deleted row is flagged as a conflict, never silently dropped ──
  {
    let toastMsgs = [];
    const { sandbox } = buildSandbox({ bid: 'biz-1', rows: {}, showToastFn: function (m) { toastMsgs.push(m); } });
    const someId = '22222222-2222-2222-2222-222222222222';
    const res = await sandbox._pentaJobWrite('update', { id: someId, patch: { price: '100' } });
    check('update of a gone row is reported as a conflict', res.conflict, true);
    checkTrue('conflict message is visible', toastMsgs.some(function (m) { return /changed or removed elsewhere/.test(m); }));
    check('a conflict is never queued for endless retry', sandbox._scheduleSaveQueue.length, 0);
  }

  // ── 7. Employee role gets no queue ──
  {
    const { sandbox } = buildSandbox({ bid: 'biz-1', role: 'employee' });
    check('_scheduleSaveCanUse is false for employee', sandbox._scheduleSaveCanUse(), false);
    const res = await sandbox._pentaJobWrite('insert', { job: { id: sandbox._generateUuidV4(), client_id: 'c1', date: '2026-11-01' } });
    check('employee write is refused outright', res.refused, true);
    check('nothing queued for a refused write', sandbox._scheduleSaveQueue.length, 0);
  }
  {
    // Defense in depth: the employee-portal shell itself is excluded
    // even if a role check were ever bypassed.
    const { sandbox } = buildSandbox({ bid: 'biz-1', role: 'owner', inPortal: true });
    check('_scheduleSaveCanUse is false inside the employee portal shell', sandbox._scheduleSaveCanUse(), false);
  }

  // ── 8. Locked/expired session does not flush, and shows the sign-in message ──
  {
    const { sandbox } = buildSandbox({ bid: 'biz-1', locked: true });
    sandbox._scheduleSaveQueueBid = 'biz-1';
    sandbox._scheduleSaveQueue = [{ queueId: 'q3', op: 'update', jobId: 'x', payload: { id: 'x', patch: {} }, attempts: 0, lastError: 'e', queuedAt: new Date().toISOString() }];
    checkTrue('locked (login screen showing) is detected', sandbox._scheduleSaveIsLocked());
    await sandbox._scheduleSaveFlushQueue();
    check('queue untouched while locked', sandbox._scheduleSaveQueue.length, 1);
  }
  {
    const { sandbox } = buildSandbox({ bid: 'biz-1', noSession: true, documentIds: { 'schedule-save-pill': { style: {}, innerHTML: '' } } });
    sandbox._scheduleSaveQueueBid = 'biz-1';
    sandbox._scheduleSaveQueue = [{ queueId: 'q4', op: 'update', jobId: 'y', payload: { id: 'y', patch: {} }, attempts: 0, lastError: 'e', queuedAt: new Date().toISOString() }];
    await sandbox._scheduleSaveFlushQueue();
    check('expired session leaves the item queued (never flushed)', sandbox._scheduleSaveQueue.length, 1);
    checkTrue('expired-session flag is set', sandbox._scheduleSaveSessionExpired);
    const slot = sandbox.document.getElementById('schedule-save-pill');
    sandbox._scheduleSaveRenderPillInto(slot);
    checkTrue('pill shows the sign-in-again message, not a silent failure', /Sign in again/.test(slot.innerHTML));
  }

  // ── 9. Claire's schedule tools go through the helper (no bypass) ──
  {
    // Claire's cancel_clean/move_clean/change_price handlers are deep
    // inside executeClaireToolCall's large dispatcher (DOM/chat-UI
    // heavy, not practical to extract standalone here). Confirmed
    // directly instead: no call site anywhere in index.html still
    // calls window.PentaJobs.insert/update/remove/insertBatch/
    // removeByLegacyPrefix/removeFutureForClient except
    // _scheduleSaveExecuteOp itself and PentaJobs' own internals.
    const directCalls = (src.match(/window\.PentaJobs\.(insert|update|remove|insertBatch|removeByLegacyPrefix|removeFutureForClient)\(/g) || []);
    const insideHelperOnly = extract('async function _scheduleSaveExecuteOp', 'async function _pentaJobWrite', 'helper internals').match(/window\.PentaJobs\.(insert|update|remove)\(/g) || [];
    check('every direct PentaJobs write call site is inside _scheduleSaveExecuteOp (none bypass the helper)', directCalls.length, insideHelperOnly.length);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
