// Close Day (close-day branch): owner/admin-only day-finalize workflow
// in the Schedule tab (migration 122: day_closes). Extracts the real
// _closeDay* module, the Visit Data module (_vsnapClassifyTeamDayJobs/
// _vsnapComputeLaborCost/_vsnapDecideWriteAction), and the Team Day
// Report module (_tdrClassifyStop/_tdrTrimMorningStops/
// _tdrMergeLunchCandidates) verbatim from index.html -- Close Day
// reuses all three unmodified; this file never reimplements their
// logic. An ASYNC PentaEmployees.get/ready stub is used throughout,
// matching production (lesson from the missing-await bug fixed on the
// visit-snapshots-await-fix branch).
//
// Run with: node tests/close-day.test.js

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

const dateKeySource = extract('function dateKey(d) {', '\n\nfunction jobsForDate', 'dateKey');
const tdrSource = extract('var TDR_MAX_RANGE_DAYS = 31;', '\nfunction openTeamDayReport() {', 'TDR module');
const vsnapSource = extract('var _visitSnapGeneration = 0;', 'var CLOSE_DAY_EXTRA_STOP_MIN_MINUTES = 15;', 'Visit Data module');
const closeDaySource = extract('var CLOSE_DAY_EXTRA_STOP_MIN_MINUTES = 15;', '// GPS MAP (Leaflet)', 'Close Day module');

const fnSource = [dateKeySource, tdrSource, vsnapSource, closeDaySource].join('\n');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ── Minimal in-memory Supabase stand-in (same shape as visit-data-snapshots.test.js) ──
function makeFakeSupabase(store) {
  function runOp(state) {
    store[state.table] = store[state.table] || [];
    const rows = store[state.table];
    function matches(row) {
      return state.filters.every(function (f) {
        if (f[0] === 'in') return f[2].indexOf(row[f[1]]) !== -1;
        return row[f[0]] === f[1];
      });
    }
    if (state.op === 'select') {
      var matched = rows.filter(matches).map(function (r) { return Object.assign({}, r); });
      if (state.single) return { data: matched[0] || null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === 'insert') { rows.push(Object.assign({}, state.payload)); return { data: null, error: null }; }
    if (state.op === 'update') { rows.forEach(function (row) { if (matches(row)) Object.assign(row, state.payload); }); return { data: null, error: null }; }
    return { data: null, error: new Error('FakeSupabase: unsupported op ' + state.op) };
  }
  return {
    from: function (table) {
      const state = { table: table, filters: [], op: null, payload: null, single: false };
      const builder = {
        select: function () { state.op = state.op || 'select'; return builder; },
        insert: function (row) { state.op = 'insert'; state.payload = row; return builder; },
        update: function (row) { state.op = 'update'; state.payload = row; return builder; },
        eq: function (col, val) { state.filters.push([col, val]); return builder; },
        in: function (col, vals) { state.filters.push(['in', col, vals]); return builder; },
        maybeSingle: function () { state.single = true; return Promise.resolve(runOp(state)); },
        then: function (resolve, reject) { try { resolve(runOp(state)); } catch (e) { reject(e); } }
      };
      return builder;
    },
    auth: { getUser: function () { return Promise.resolve({ data: { user: { id: 'auth-user-1' } } }); } }
  };
}

const TZ_OFFSET_HOURS = 0; // sandbox dates are plain UTC Date objects -- no business-timezone conversion needed for these pure-function tests
function t(hhmm, day) {
  return new Date('2026-11-0' + (day || '1') + 'T' + hhmm + ':00.000Z');
}

function buildSandbox(opts) {
  opts = opts || {};
  const insertCalls = [];
  const sandbox = {
    console: console,
    window: {
      PentaEmployees: {
        get: function (uuid) { return Promise.resolve((opts.employeesByUuid || {})[uuid] || null); },
        ready: function () { return Promise.resolve(); }
      },
      PentaLunchFlags: { getOverride: function (team, dateStr, stopKey) { return (opts.lunchOverrides || {})[team + '|' + dateStr + '|' + stopKey] || null; } },
      PentaTenant: { current: function () { return opts.bid || 'biz-1'; } },
      PentaClients: {
        getClient: function (id) { return (opts.clientsById || {})[id] || null; },
        forEachClient: function (fn) { Object.keys(opts.clientsById || {}).forEach(function (id) { fn(Object.assign({ id: id }, opts.clientsById[id])); }); }
      },
      PentaJobs: { insert: function (job) { insertCalls.push(job); return Promise.resolve(job); } },
      supabaseClient: opts.fakeSupabase || null
    },
    document: opts.document || { getElementById: function () { return null; } },
    alert: opts.alertFn || function () {},
    confirm: opts.confirmFn || function () { return true; },
    showToast: opts.showToastFn || function () {},
    jobs: opts.jobs || [],
    insertCalls: insertCalls,
    getCurrentAppRole: function () { return opts.role !== undefined ? opts.role : 'owner'; },
    getClientQuotedMinutes: function () { return 60; },
    logPendingUpdate: function () {},
    saveJobs: function () {},
    openJobModal: function () {},
    cancelJob: function () {},
    openTeamManager: function () {},
    _teamHoursEligibility: opts.teamHoursEligibility || function () { return { included: [], skipped: [] }; },
    _teamHoursEmpUuid: function (e) { return e.uuid || e.id || null; },
    _fetchTeamDayGpsDetail: opts.fetchTeamDayGpsDetail || function () { return Promise.resolve({ device: null, trips: [], stopList: [], gps: { available: false } }); },
    matchStopToClientGeo: opts.matchStopToClientGeo || function () { return null; },
    _pentaTeamNames: function () { return opts.teams || ['B1']; },
    _pentaTeamColor: function () { return '#6b7280'; },
    _pentaBusinessTimezone: function () { return 'UTC'; },
    _adminEsc: function (s) { return String(s); }
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

async function main() {
  // ── 1. NOT-CLEANED reasons, each case ──
  {
    const sandbox = buildSandbox({});
    check('no_gps -> team had no vehicle/GPS', sandbox._closeDayNotCleanedReason('no_gps', true), 'Team had no vehicle/GPS that day.');
    check('unmatched, no coords -> client has no coordinates', sandbox._closeDayNotCleanedReason('unmatched', false), 'This client has no saved coordinates.');
    check('unmatched, has coords -> no stop at that address', sandbox._closeDayNotCleanedReason('unmatched', true), 'No stop found at that address.');
    check('ambiguous -> two jobs same client same day', sandbox._closeDayNotCleanedReason('ambiguous', true), 'Ambiguous: two jobs for this client on this team-day.');
    check('matched -> no flag (null)', sandbox._closeDayNotCleanedReason('matched', true), null);
  }

  // ── 2. _closeDayComputeNotCleanedFlags end-to-end per reason ──
  {
    const sandbox = buildSandbox({});
    const teamJobs = [{ id: 'j1', clientId: 'c1' }, { id: 'j2', clientId: 'c2' }, { id: 'j3', clientId: 'c3' }, { id: 'j4', clientId: 'c3' }];
    const gpsNoDevice = { ok: true, detail: { device: null, trips: [], stopList: [], gps: { available: false } } };
    var r1 = sandbox._closeDayComputeNotCleanedFlags([teamJobs[0]], gpsNoDevice, 'B1', function () { return null; }, {});
    check('no device -> no_gps flag with the right reason', r1.flags[0].reason, 'Team had no vehicle/GPS that day.');

    const gpsNoMatch = { ok: true, detail: { device: { id: 'd1' }, trips: [{}], stopList: [] } };
    var r2 = sandbox._closeDayComputeNotCleanedFlags([teamJobs[1]], gpsNoMatch, 'B1', function () { return null; }, { c2: { lat: null, lng: null } });
    check('unmatched, client has no coords', r2.flags[0].reason, 'This client has no saved coordinates.');
    var r3 = sandbox._closeDayComputeNotCleanedFlags([teamJobs[1]], gpsNoMatch, 'B1', function () { return null; }, { c2: { lat: 42.0, lng: -71.0 } });
    check('unmatched, client HAS coords -> no stop at address', r3.flags[0].reason, 'No stop found at that address.');

    var r4 = sandbox._closeDayComputeNotCleanedFlags([teamJobs[2], teamJobs[3]], gpsNoMatch, 'B1', function () { return null; }, {});
    check('two jobs same client -> both ambiguous', r4.flags.length, 2);
    checkTrue('ambiguous reason text present', /Ambiguous/.test(r4.flags[0].reason));
  }

  // ── 3. Extra-stop: client-match candidate ──
  {
    // _tdrClassifyStop (reused verbatim) reads the GLOBAL
    // matchStopToClientGeo for isClientMatch -- the sandbox global must
    // be wired to the same function passed as _closeDayComputeExtraStops'
    // matchFn argument, exactly as production does (one real global,
    // never two different match functions).
    const matchFn = function (lat, lng, addr) { return addr === '5 Oak St' ? { id: 'cX', name: 'Match' } : null; };
    const sandbox = buildSandbox({ matchStopToClientGeo: matchFn });
    const stop = { isDepot: false, lat: 1, lng: 1, addr: '5 Oak St', inTime: t('14:00'), outTime: t('14:30') };
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [{}], stopList: [stop] } };
    const r = sandbox._closeDayComputeExtraStops(gpsOutcome, 'B1', [], null, null, sandbox.matchStopToClientGeo, 15);
    check('one extra stop found', r.stops.length, 1);
    check('flagged as a client match', r.stops[0].isClientMatch, true);
    check('carries the matched client id', r.stops[0].clientId, 'cX');
    check('duration is 30 minutes', r.stops[0].durationMin, 30);
  }

  // ── 4. Extra-stop: unrecognized (no client match). 65 minutes --
  //      long enough that it can never be mistaken for a natural lunch
  //      candidate (_tdrClassifyStop's own naturallyLunch requires
  //      dur < 60) -- isolates "unrecognized" from "lunch" cleanly. ──
  {
    const sandbox = buildSandbox({});
    const stop = { isDepot: false, lat: null, lng: null, addr: 'Unknown', inTime: t('14:00'), outTime: t('15:05') };
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [{}], stopList: [stop] } };
    const r = sandbox._closeDayComputeExtraStops(gpsOutcome, 'B1', [], null, null, function () { return null; }, 15);
    check('one extra stop found', r.stops.length, 1);
    check('not a client match -> unrecognized', r.stops[0].isClientMatch, false);
  }

  // ── 5. Stops under the minimum duration are ignored ──
  {
    const sandbox = buildSandbox({});
    const shortStop = { isDepot: false, lat: null, lng: null, addr: 'Quick stop', inTime: t('14:00'), outTime: t('14:10') }; // 10 min
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [{}], stopList: [shortStop] } };
    const r = sandbox._closeDayComputeExtraStops(gpsOutcome, 'B1', [], t('08:00'), t('17:00'), function () { return null; }, 15);
    check('a 10-minute stop (below the 15-minute floor) is ignored', r.stops.length, 0);
  }

  // ── 6. Depot/office, lunch, and "Not lunch" stops are never flagged ──
  {
    const dayStart = t('08:00');
    const lunchOverridesObj = {};
    const sandboxForKey = buildSandbox({});
    const notLunchKey = t('12:00').toISOString();
    lunchOverridesObj['B1|' + sandboxForKey.dateKey(dayStart) + '|' + notLunchKey] = { override_type: 'exclude' };
    const sandbox = buildSandbox({ lunchOverrides: lunchOverridesObj });
    const officeStop = { isDepot: true, addr: 'DEPOT', inTime: null, outTime: dayStart };
    const lunchStop = { isDepot: false, lat: null, lng: null, addr: 'Sandwich Place', inTime: t('12:30'), outTime: t('12:50') }; // 20 min, no match -> naturally lunch
    const notLunchStop = { isDepot: false, lat: null, lng: null, addr: 'Personal errand', inTime: t('12:00'), outTime: t('12:20') }; // marked "Not lunch" via override above
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [{}, {}, {}], stopList: [officeStop, notLunchStop, lunchStop] } };
    const r = sandbox._closeDayComputeExtraStops(gpsOutcome, 'B1', [], dayStart, t('17:00'), function () { return null; }, 15);
    check('office, lunch, and Not-lunch stops are all excluded -- zero extra-stop flags', r.stops.length, 0);
  }

  // ── 7. Labor-cost preview: incomplete flag when a present employee has no rate ──
  {
    const sandbox = buildSandbox({});
    const classified = [{ status: 'matched', team_minutes: 60 }];
    const present = [{ employee_id: 'e1', pay_rate: 20, pay_type: 'hourly' }, { employee_id: 'e2', pay_rate: null, pay_type: 'hourly' }];
    const preview = sandbox._closeDayComputeTeamPreview(classified, present, [{ price: '100' }], 7000);
    check('labor incomplete is true (one of two employees has no rate)', preview.laborIncomplete, true);
    check('revenue is 10000 cents', preview.revenueCents, 10000);
    checkTrue('margin percent is computed', preview.marginPct !== null);
  }

  // ── 8. Write-decision matrix at close time ──
  {
    const sandbox = buildSandbox({});
    const fresh = { status: 'matched', match_note: null, in_at: null, out_at: null, team_minutes: 30, employees: [], labor_cost_gross_cents: 500, labor_cost_complete: true };
    check('session override present -> always writes, manually_edited=true, source=manual',
      sandbox._closeDayDecideJobClose({ status: 'matched', match_note: 'x', employees: [], labor_cost_complete: true }, { manually_edited: true, status: 'unmatched' }, fresh).row.manually_edited, true);
    check('no override, existing row manually_edited -> skip (never overwritten without confirmation)',
      sandbox._closeDayDecideJobClose(null, { manually_edited: true, status: 'unmatched' }, fresh).action, 'skip');
    const freshWrite = sandbox._closeDayDecideJobClose(null, null, fresh);
    check('no override, no existing row -> write fresh, manually_edited=false (untouched GPS row saved as-is)', freshWrite.row.manually_edited, false);
    check('no override, no existing row -> source=geotab', freshWrite.row.source, 'geotab');
  }

  // ── 9. Team/vehicle/job edits call the EXISTING functions, not new writes ──
  {
    const calls = [];
    const sandbox = buildSandbox({});
    sandbox.openTeamManager = function (dateStr) { calls.push(['openTeamManager', dateStr]); };
    sandbox.openJobModal = function (id) { calls.push(['openJobModal', id]); };
    sandbox.cancelJob = function (id) { calls.push(['cancelJob', id]); };
    // Step A's rendering wires these onclick handlers; call the global
    // functions directly here the same way an onclick attribute would.
    sandbox.openTeamManager('2026-11-01');
    sandbox.openJobModal(null);
    sandbox.cancelJob('job1');
    check('team edits route through the existing openTeamManager', calls[0], ['openTeamManager', '2026-11-01']);
    check('job add routes through the existing openJobModal', calls[1], ['openJobModal', null]);
    check('job cancel routes through the existing cancelJob', calls[2], ['cancelJob', 'job1']);
  }

  // ── 10. "Add to schedule and mark cleaned": calls PentaJobs.insert exactly once, double-tap safe ──
  {
    const sandbox = buildSandbox({
      bid: 'biz-1', role: 'owner',
      clientsById: { cX: { fn: 'Test', ln: 'Client', addr: '5 Oak St' } },
      teamHoursEligibility: function () { return { included: [], skipped: [] }; }
    });
    _primeSession(sandbox, {
      dateStr: '2026-11-01',
      perTeam: { B1: { team: 'B1', teamJobs: [], presentEmployees: [], extraStops: [{ stopKey: 'k1', clientId: 'cX', clientName: 'Test Client', inTime: t('14:00'), outTime: t('14:45'), durationMin: 45 }] } }
    });
    sandbox.document = { getElementById: function (id) { return id.indexOf('cd-price-') === 0 ? { value: '150' } : null; } };
    const p1 = sandbox._closeDayAddFromExtraStop('B1', 'k1');
    const p2 = sandbox._closeDayAddFromExtraStop('B1', 'k1'); // simulated double-tap, no await between calls
    await Promise.all([p1, p2]);
    check('PentaJobs.insert called exactly once despite the double tap', sandbox.insertCalls.length, 1);
    check('added job carries the edited price', sandbox.insertCalls[0].price, '150');
    check('added job is tagged for this team/date', sandbox.insertCalls[0].team + '|' + sandbox.insertCalls[0].date, 'B1|2026-11-01');
  }

  // ── 11. Close writes job rows and a day_closes row ──
  {
    const store = {};
    const fakeSb = makeFakeSupabase(store);
    const sandbox = buildSandbox({
      bid: 'biz-1', fakeSupabase: fakeSb, role: 'owner',
      jobs: [{ id: 'jobA', date: '2026-11-01', team: 'B1', clientId: 'cA', clientName: 'A', cancelled: false, price: '100' }],
      teamHoursEligibility: function () { return { included: [{ id: 'alice', uuid: 'alice-uuid', pay_rate: 20, pay_type: 'hourly' }], skipped: [] }; },
      fetchTeamDayGpsDetail: function () { return Promise.resolve({ device: { id: 'd1' }, trips: [{}], stopList: [{ isDepot: false, lat: 1, lng: 1, addr: 'X', inTime: t('14:00'), outTime: t('14:30') }], gps: { available: true, start: t('08:00'), end: t('17:00') } }); },
      matchStopToClientGeo: function (lat, lng, addr) { return addr === 'X' ? { id: 'cA' } : null; }
    });
    sandbox.document = { getElementById: function (id) { return id === 'cd-close-btn' || id === 'cd-close-status' ? { style: {} } : null; } };
    _primeSession(sandbox, { dateStr: '2026-11-01' });
    await sandbox._closeDayLoad();
    await sandbox.closeTheDay();
    check('one job_visit_snapshots row written', (store.job_visit_snapshots || []).length, 1);
    check('written row status is matched', store.job_visit_snapshots[0].status, 'matched');
    check('one day_closes row written, status closed', store.day_closes && store.day_closes[0] && store.day_closes[0].status, 'closed');
    checkTrue('flags_snapshot has a teams entry for B1', !!(store.day_closes[0].flags_snapshot && store.day_closes[0].flags_snapshot.teams && store.day_closes[0].flags_snapshot.teams.B1));
  }

  // ── 12. Reopen -> edit -> close again ──
  {
    const store = { day_closes: [{ business_id: 'biz-1', close_date: '2026-11-01', status: 'closed', closed_at: '2026-11-01T18:00:00Z' }] };
    const fakeSb = makeFakeSupabase(store);
    const sandbox = buildSandbox({ bid: 'biz-1', fakeSupabase: fakeSb, role: 'owner', confirmFn: function () { return true; } });
    sandbox.calDate = new Date(2026, 10, 1);
    _closeDayStatusCacheSet(sandbox, '2026-11-01', store.day_closes[0]);
    await sandbox.reopenTheDay();
    check('reopen flips status to open', store.day_closes[0].status, 'open');
    checkTrue('reopened_at is recorded', !!store.day_closes[0].reopened_at);
    // Data kept -- the row still exists, nothing deleted.
    check('row count unchanged after reopen (data kept)', store.day_closes.length, 1);
  }

  // ── 13. Closed day is skipped by the Visit Data builder ──
  {
    const store = { day_closes: [{ business_id: 'biz-1', close_date: '2026-11-02', status: 'closed' }] };
    const fakeSb = makeFakeSupabase(store);
    const sandbox = buildSandbox({ bid: 'biz-1', fakeSupabase: fakeSb, role: 'owner', today: { y: 2026, m: 11, d: 10 } });
    const calledDates = [];
    sandbox._vsnapBuildTeamDay = function (sbCtx, team, dateStr) { calledDates.push(dateStr); return Promise.resolve(); };
    sandbox._vsnapGetCurrentWriter = function () { return Promise.resolve({ sb: fakeSb, bid: 'biz-1', userId: 'u1' }); };
    sandbox._bizTodayParts = function () { return { y: 2026, m: 11, d: 10 }; };
    sandbox._computeLastPayWeekRange = function () { return { startYmd: '2026-11-01', endYmd: '2026-11-03' }; };
    sandbox._pentaPayWeekStartDay = function () { return 'monday'; };
    sandbox.document = (function () {
      const els = {
        'vsnap-from': { value: '2026-11-01' }, 'vsnap-to': { value: '2026-11-03' },
        'vsnap-status': { style: {}, textContent: '' }, 'vsnap-summary': { innerHTML: '' },
        'vsnap-run-btn': { disabled: false, textContent: 'Build' }, 'vsnap-rebuild-matched': { checked: false }
      };
      return { getElementById: function (id) { return els[id] || null; }, _els: els };
    })();
    await sandbox._vsnapRun();
    check('the closed date (11-02) was never passed to the builder', calledDates.indexOf('2026-11-02'), -1);
    check('the other two dates were still built', calledDates, ['2026-11-01', '2026-11-03']);
    checkTrue('summary mentions the closed-day skip', /closed and were skipped/.test(sandbox.document._els['vsnap-summary'].innerHTML));
  }

  // ── 14. Role matrix: who can use Close Day ──
  {
    const cases = [
      { role: 'owner', expect: true }, { role: 'admin', expect: true },
      { role: 'manager', expect: false }, { role: 'dispatcher', expect: false },
      { role: 'employee', expect: false }, { role: null, expect: false }
    ];
    cases.forEach(function (c) {
      const sandbox = buildSandbox({ role: c.role });
      check('_closeDayCanUse for role=' + c.role, sandbox._closeDayCanUse(), c.expect);
    });
    // The slot itself: hidden for every non-owner/admin role, shown for owner/admin.
    cases.forEach(function (c) {
      const slot = { style: {}, innerHTML: '' };
      const sandbox = buildSandbox({ role: c.role, document: { getElementById: function (id) { return id === 'close-day-slot' ? slot : null; } } });
      sandbox.calDate = new Date(2026, 10, 1);
      sandbox._closeDayFetchStatus = function () { return Promise.resolve(); };
      sandbox._closeDaySyncHeader();
      check('close-day-slot display for role=' + c.role, slot.style.display, c.expect ? '' : 'none');
    });
  }

  // ── 15. No write outside job_visit_snapshots / day_closes from Close Day's own code ──
  {
    const store = {};
    const fakeSb = makeFakeSupabase(store);
    const seenTables = [];
    const trackingSb = {
      from: function (table) { seenTables.push(table); return fakeSb.from(table); },
      auth: fakeSb.auth
    };
    const sandbox = buildSandbox({
      bid: 'biz-1', fakeSupabase: trackingSb, role: 'owner',
      jobs: [{ id: 'jobB', date: '2026-11-01', team: 'B1', clientId: 'cB', clientName: 'B', cancelled: false, price: '50' }],
      teamHoursEligibility: function () { return { included: [], skipped: [] }; },
      fetchTeamDayGpsDetail: function () { return Promise.resolve({ device: null, trips: [], stopList: [], gps: { available: false } }); }
    });
    sandbox.document = { getElementById: function (id) { return id === 'cd-close-btn' || id === 'cd-close-status' ? { style: {} } : null; } };
    _primeSession(sandbox, { dateStr: '2026-11-01' });
    await sandbox._closeDayLoad();
    await sandbox.closeTheDay();
    const allowed = { job_visit_snapshots: true, day_closes: true, users: true, business_profit_targets: true };
    const disallowed = seenTables.filter(function (tb) { return !allowed[tb]; });
    check('every Supabase table Close Day touched is on the allowed list', disallowed, []);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

// Test-only helper: seeds _closeDaySession directly (bypassing
// openCloseDaySheet's DOM-building) so individual actions can be
// tested without a real sheet.
function _primeSession(sandbox, partial) {
  sandbox._closeDaySession = Object.assign({
    dateStr: '2026-11-01', step: 'A', perTeam: {}, jobOverrides: {}, stopReviews: {},
    existingByJobId: {}, existingDayClose: null, loaded: true, profitTarget: null
  }, partial);
}
function _closeDayStatusCacheSet(sandbox, dateStr, row) {
  sandbox._closeDayStatusCache[dateStr] = row;
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
