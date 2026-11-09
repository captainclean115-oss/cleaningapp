// Visit Data tool (visit-snapshots branch, Stage 1 of the per-clean
// profitability feature). Extracts the real _vsnap* module, FILES_LIST
// + renderFilesGrid, and _tdrExpandDateRange verbatim from index.html.
// A tiny in-memory Supabase stand-in (FakeSupabase below) backs the
// write-once / idempotency / manually_edited tests -- it supports just
// the chain shapes this module actually calls (.select/.eq/.in,
// .insert, .update/.eq/.eq), nothing more.
//
// Run with: node tests/visit-data-snapshots.test.js

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

const vsnapSource = extract('var _visitSnapGeneration = 0;', '// GPS MAP (Leaflet)', 'Visit Data module');
const filesSource = extract('var FILES_LIST = [', '// STAFF CHAT', 'FILES_LIST + renderFilesGrid');
const tdrRangeSource = extract('var TDR_MAX_RANGE_DAYS = 31;', '// "This week"', '_tdrExpandDateRange');
const dateKeySource = extract('function dateKey(d) {', '\n\nfunction jobsForDate', 'dateKey');

const fnSource = [dateKeySource, tdrRangeSource, filesSource, vsnapSource].join('\n');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ── Minimal in-memory Supabase stand-in ─────────────────────────────
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
      return { data: rows.filter(matches).map(function (r) { return Object.assign({}, r); }), error: null };
    }
    if (state.op === 'insert') {
      rows.push(Object.assign({}, state.payload));
      return { data: null, error: null };
    }
    if (state.op === 'update') {
      rows.forEach(function (row) { if (matches(row)) Object.assign(row, state.payload); });
      return { data: null, error: null };
    }
    return { data: null, error: new Error('FakeSupabase: unsupported op ' + state.op) };
  }
  return {
    from: function (table) {
      const state = { table: table, filters: [], op: null, payload: null };
      const builder = {
        select: function () { state.op = state.op || 'select'; return builder; },
        insert: function (row) { state.op = 'insert'; state.payload = row; return builder; },
        update: function (row) { state.op = 'update'; state.payload = row; return builder; },
        eq: function (col, val) { state.filters.push([col, val]); return builder; },
        in: function (col, vals) { state.filters.push(['in', col, vals]); return builder; },
        then: function (resolve, reject) {
          try { resolve(runOp(state)); } catch (e) { reject(e); }
        }
      };
      return builder;
    },
    auth: { getUser: function () { return Promise.resolve({ data: { user: { id: 'auth-user-1' } } }); } }
  };
}

function buildSandbox(opts) {
  opts = opts || {};
  const sandbox = {
    console: console,
    window: {
      // Matches the REAL production API: PentaEmployees.get is async
      // (returns a Promise), and ready() resolves once the cache is
      // warm. A stub that returned the plain object directly (not a
      // Promise) would have hidden the missing-await bug this file
      // exists to catch -- see "regression" test below.
      PentaEmployees: {
        get: function (uuid) { return Promise.resolve((opts.employeesByUuid || {})[uuid] || null); },
        ready: function () { return Promise.resolve(); }
      },
      PentaTenant: { current: function () { return opts.bid || 'biz-1'; } },
      supabaseClient: opts.fakeSupabase || null
    },
    document: opts.document || { getElementById: function () { return null; } },
    alert: opts.alertFn || function () {},
    showToast: opts.showToastFn || function () {},
    jobs: opts.jobs || [],
    getCurrentAppRole: function () { return opts.role !== undefined ? opts.role : 'owner'; },
    _teamHoursEligibility: opts.teamHoursEligibility || function () { return { included: [], skipped: [] }; },
    _teamHoursEmpUuid: function (e) { return e.uuid || e.id; },
    _fetchTeamDayGpsDetail: opts.fetchTeamDayGpsDetail || function () { return Promise.resolve({ device: null, trips: [], stopList: [], gps: { available: false } }); },
    matchStopToClientGeo: opts.matchStopToClientGeo || function () { return null; },
    _pentaTeamNames: function () { return opts.teams || ['B1']; },
    _pentaBusinessTimezone: function () { return 'UTC'; },
    _pentaPayWeekStartDay: function () { return 'monday'; },
    _bizTodayParts: function () { return opts.today || { y: 2026, m: 11, d: 10 }; },
    _computeLastPayWeekRange: function () { return { startYmd: '2026-11-02', endYmd: '2026-11-08' }; },
    _adminEsc: function (s) { return String(s); }
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

async function main() {
  // ── 1. Single stop cleanly matches -> 'matched' with correct minutes ──
  {
    const sandbox = buildSandbox({});
    const teamJobs = [{ id: 'job1', clientId: 'c1' }];
    const stop = { isDepot: false, lat: 1, lng: 1, addr: '1 Main St', inTime: new Date('2026-11-01T14:00:00Z'), outTime: new Date('2026-11-01T14:45:00Z') };
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [{}], stopList: [stop] } };
    const matchFn = function (lat, lng, addr) { return addr === '1 Main St' ? { id: 'c1', name: 'X' } : null; };
    const result = sandbox._vsnapClassifyTeamDayJobs(teamJobs, gpsOutcome, 'B1', matchFn);
    check('single clean match -> status matched', result[0].status, 'matched');
    check('single clean match -> correct minutes', result[0].team_minutes, 45);
  }

  // ── 2. Two jobs for the same client same day -> ambiguous, no minutes ──
  {
    const sandbox = buildSandbox({});
    const teamJobs = [{ id: 'job1', clientId: 'c1' }, { id: 'job2', clientId: 'c1' }];
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [{}], stopList: [] } };
    const result = sandbox._vsnapClassifyTeamDayJobs(teamJobs, gpsOutcome, 'B1', function () { return null; });
    check('duplicate-client job 1 -> ambiguous', result[0].status, 'ambiguous');
    check('duplicate-client job 2 -> ambiguous', result[1].status, 'ambiguous');
    check('ambiguous -> no minutes saved (job 1)', result[0].team_minutes, null);
    check('ambiguous -> no minutes saved (job 2)', result[1].team_minutes, null);
  }

  // ── 3. No coordinates / no address match -> unmatched ──
  {
    const sandbox = buildSandbox({});
    const teamJobs = [{ id: 'job1', clientId: 'c1' }];
    const stop = { isDepot: false, lat: null, lng: null, addr: 'Unknown', inTime: new Date(), outTime: new Date() };
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [{}], stopList: [stop] } };
    const result = sandbox._vsnapClassifyTeamDayJobs(teamJobs, gpsOutcome, 'B1', function () { return null; });
    check('no client match -> unmatched', result[0].status, 'unmatched');
  }

  // ── 4. No device -> no_gps ──
  {
    const sandbox = buildSandbox({});
    const teamJobs = [{ id: 'job1', clientId: 'c1' }];
    const gpsOutcome = { ok: true, detail: { device: null, trips: [], stopList: [], gps: { available: false, reason: 'No GPS device assigned to B1' } } };
    const result = sandbox._vsnapClassifyTeamDayJobs(teamJobs, gpsOutcome, 'B1', function () { return null; });
    check('no device -> no_gps', result[0].status, 'no_gps');
  }

  // ── 5. No trips (device exists, nothing recorded) -> no_gps ──
  {
    const sandbox = buildSandbox({});
    const teamJobs = [{ id: 'job1', clientId: 'c1' }];
    const gpsOutcome = { ok: true, detail: { device: { id: 'd1' }, trips: [], stopList: [] } };
    const result = sandbox._vsnapClassifyTeamDayJobs(teamJobs, gpsOutcome, 'B1', function () { return null; });
    check('no trips -> no_gps', result[0].status, 'no_gps');
  }

  // ── 6. Rate frozen; missing rate / salaried excluded from sum ──
  {
    const sandbox = buildSandbox({});
    const present = [
      { employee_id: 'e1', pay_rate: 20, pay_type: 'hourly' },
      { employee_id: 'e2', pay_rate: null, pay_type: 'hourly' },   // no rate on file
      { employee_id: 'e3', pay_rate: 30, pay_type: 'salary' }       // salaried
    ];
    const r = sandbox._vsnapComputeLaborCost(present, 60); // 60 minutes = 1 hour
    check('ratable employee frozen at 2000 cents/hr', r.employees[0].rate_cents_per_hour, 2000);
    check('no-rate employee has null frozen rate', r.employees[1].rate_cents_per_hour, null);
    check('salaried employee has null frozen rate', r.employees[2].rate_cents_per_hour, null);
    check('sum excludes the two non-ratable employees (only e1: 2000 cents)', r.labor_cost_gross_cents, 2000);
    checkTrue('labor_cost_complete is false (2 of 3 excluded)', r.labor_cost_complete === false);
  }

  // ── 6b. Every present employee ratable -> complete ──
  {
    const sandbox = buildSandbox({});
    const present = [{ employee_id: 'e1', pay_rate: 20, pay_type: 'hourly' }, { employee_id: 'e2', pay_rate: 25, pay_type: 'hourly' }];
    const r = sandbox._vsnapComputeLaborCost(present, 60);
    check('both ratable -> sum is 4500 cents', r.labor_cost_gross_cents, 4500);
    checkTrue('labor_cost_complete is true', r.labor_cost_complete === true);
  }

  // ── 6c. team_minutes null (no match yet) -> nothing computed ──
  {
    const sandbox = buildSandbox({});
    const r = sandbox._vsnapComputeLaborCost([{ employee_id: 'e1', pay_rate: 20, pay_type: 'hourly' }], null);
    check('no minutes -> labor_cost_gross_cents null', r.labor_cost_gross_cents, null);
    checkTrue('no minutes -> labor_cost_complete false', r.labor_cost_complete === false);
  }

  // ── 7. Write-once rule matrix (_vsnapDecideWriteAction) ──
  {
    const sandbox = buildSandbox({});
    check('no existing row -> insert', sandbox._vsnapDecideWriteAction(null, false), 'insert');
    check('manually_edited row, status unmatched -> never touched', sandbox._vsnapDecideWriteAction({ manually_edited: true, status: 'unmatched' }, false), 'skip_already_built');
    check('manually_edited row, even with rebuild checked -> never touched', sandbox._vsnapDecideWriteAction({ manually_edited: true, status: 'matched' }, true), 'skip_already_built');
    check('matched row, rebuild OFF -> skipped (already built)', sandbox._vsnapDecideWriteAction({ manually_edited: false, status: 'matched' }, false), 'skip_already_built');
    check('matched row, rebuild ON -> update', sandbox._vsnapDecideWriteAction({ manually_edited: false, status: 'matched' }, true), 'update');
    check('ambiguous row (not manually edited) -> always safe to retry', sandbox._vsnapDecideWriteAction({ manually_edited: false, status: 'ambiguous' }, false), 'update');
    check('no_gps row (not manually edited) -> always safe to retry', sandbox._vsnapDecideWriteAction({ manually_edited: false, status: 'no_gps' }, false), 'update');
  }

  // ── 8. Integration: employees included/excluded per date-aware roster,
  //      cancelled jobs excluded, rate frozen into the written row ──
  {
    const store = {};
    const fakeSb = makeFakeSupabase(store);
    const sandbox = buildSandbox({
      bid: 'biz-1',
      fakeSupabase: fakeSb,
      jobs: [
        { id: 'job1', date: '2026-11-01', team: 'B1', clientId: 'c1', cancelled: false },
        { id: 'job2', date: '2026-11-01', team: 'B1', clientId: 'c2', cancelled: true } // cancelled -- must never appear
      ],
      teamHoursEligibility: function () {
        // pay_rate/pay_type sit directly on the roster row, matching
        // getUnifiedRoster's real facade passthrough -- this is what
        // the fixed builder actually reads.
        return { included: [{ id: 'alice', uuid: 'alice-uuid', pay_rate: 20, pay_type: 'hourly' }], skipped: [{ emp: { id: 'bob' }, reason: 'Terminated' }] };
      },
      // Deliberately WRONG/decoy values here -- the fixed builder must
      // NEVER read pay_rate/pay_type through PentaEmployees.get() at
      // all (that's exactly where the missing-await bug lived). If a
      // future change reintroduces that call, this decoy would leak
      // into the written row and the checks below would catch it.
      employeesByUuid: { 'alice-uuid': { payRate: 999, pay_type: 'salary' } },
      fetchTeamDayGpsDetail: function () { return Promise.resolve({ device: { id: 'd1' }, trips: [{}], stopList: [{ isDepot: false, lat: 1, lng: 1, addr: 'X', inTime: new Date('2026-11-01T14:00:00Z'), outTime: new Date('2026-11-01T14:30:00Z') }] }); },
      matchStopToClientGeo: function (lat, lng, addr) { return addr === 'X' ? { id: 'c1' } : null; }
    });
    const sbCtx = { sb: fakeSb, bid: 'biz-1', userId: 'user-1' };
    const counts = { matched: 0, ambiguous: 0, no_gps: 0, unmatched: 0, skipped: 0, alreadyBuilt: 0, incompleteLaborCost: 0, writeErrors: 0 };
    await sandbox._vsnapBuildTeamDay(sbCtx, 'B1', '2026-11-01', false, counts);
    check('exactly one row written (cancelled job2 excluded)', store.job_visit_snapshots.length, 1);
    const row = store.job_visit_snapshots[0];
    check('written row is for the non-cancelled job', row.job_id, 'job1');
    check('written row status is matched', row.status, 'matched');
    check('team_minutes is 30 (14:00-14:30)', row.team_minutes, 30);
    check('exactly one employee present (Alice only -- Bob skipped/terminated)', row.employees.length, 1);
    check('present employee rate frozen at 2000 cents/hr', row.employees[0].rate_cents_per_hour, 2000);
    check('labor_cost_gross_cents is 1000 (30 min @ $20/hr)', row.labor_cost_gross_cents, 1000);
    check('counts.matched incremented', counts.matched, 1);
  }

  // ── 9. Rerun is idempotent: a 'matched' row is not touched on a second run ──
  {
    const store = {};
    const fakeSb = makeFakeSupabase(store);
    const makeOpts = function () {
      return {
        bid: 'biz-1', fakeSupabase: fakeSb,
        jobs: [{ id: 'jobA', date: '2026-11-01', team: 'B1', clientId: 'cA', cancelled: false }],
        teamHoursEligibility: function () { return { included: [{ id: 'alice', uuid: 'alice-uuid', pay_rate: 20, pay_type: 'hourly' }], skipped: [] }; },
        fetchTeamDayGpsDetail: function () { return Promise.resolve({ device: { id: 'd1' }, trips: [{}], stopList: [{ isDepot: false, lat: 1, lng: 1, addr: 'X', inTime: new Date('2026-11-01T14:00:00Z'), outTime: new Date('2026-11-01T14:30:00Z') }] }); },
        matchStopToClientGeo: function (lat, lng, addr) { return addr === 'X' ? { id: 'cA' } : null; }
      };
    };
    const sbCtx = { sb: fakeSb, bid: 'biz-1', userId: 'user-1' };
    const sandbox1 = buildSandbox(makeOpts());
    const counts1 = { matched: 0, ambiguous: 0, no_gps: 0, unmatched: 0, skipped: 0, alreadyBuilt: 0, incompleteLaborCost: 0, writeErrors: 0 };
    await sandbox1._vsnapBuildTeamDay(sbCtx, 'B1', '2026-11-01', false, counts1);
    check('first run: one row written, matched', store.job_visit_snapshots.length === 1 && store.job_visit_snapshots[0].status === 'matched', true);
    const rowAfterFirst = Object.assign({}, store.job_visit_snapshots[0]);

    const sandbox2 = buildSandbox(makeOpts());
    const counts2 = { matched: 0, ambiguous: 0, no_gps: 0, unmatched: 0, skipped: 0, alreadyBuilt: 0, incompleteLaborCost: 0, writeErrors: 0 };
    await sandbox2._vsnapBuildTeamDay(sbCtx, 'B1', '2026-11-01', false, counts2);
    check('second run: still exactly one row (no duplicate insert)', store.job_visit_snapshots.length, 1);
    check('second run: row content unchanged', JSON.stringify(store.job_visit_snapshots[0]), JSON.stringify(rowAfterFirst));
    check('second run: counted as already built, not re-counted as matched', counts2.alreadyBuilt === 1 && counts2.matched === 0, true);
  }

  // ── 10. manually_edited rows are never overwritten by a rerun ──
  {
    const store = { job_visit_snapshots: [{ business_id: 'biz-1', job_id: 'jobM', status: 'unmatched', manually_edited: true, match_note: 'Tom fixed this by hand' }] };
    const fakeSb = makeFakeSupabase(store);
    const sandbox = buildSandbox({
      bid: 'biz-1', fakeSupabase: fakeSb,
      jobs: [{ id: 'jobM', date: '2026-11-01', team: 'B1', clientId: 'cM', cancelled: false }],
      teamHoursEligibility: function () { return { included: [{ id: 'alice', uuid: 'alice-uuid', pay_rate: 20, pay_type: 'hourly' }], skipped: [] }; },
      fetchTeamDayGpsDetail: function () { return Promise.resolve({ device: { id: 'd1' }, trips: [{}], stopList: [{ isDepot: false, lat: 1, lng: 1, addr: 'X', inTime: new Date('2026-11-01T14:00:00Z'), outTime: new Date('2026-11-01T14:30:00Z') }] }); },
      matchStopToClientGeo: function (lat, lng, addr) { return addr === 'X' ? { id: 'cM' } : null; }
    });
    const sbCtx = { sb: fakeSb, bid: 'biz-1', userId: 'user-1' };
    const counts = { matched: 0, ambiguous: 0, no_gps: 0, unmatched: 0, skipped: 0, alreadyBuilt: 0, incompleteLaborCost: 0, writeErrors: 0 };
    await sandbox._vsnapBuildTeamDay(sbCtx, 'B1', '2026-11-01', true, counts); // rebuild checkbox ON -- still must not touch this row
    check('manually_edited row is completely untouched (even with rebuild ON)', store.job_visit_snapshots[0].match_note, 'Tom fixed this by hand');
    check('manually_edited row counted as already built', counts.alreadyBuilt, 1);
  }

  // ── 10b. REGRESSION: reproduces the exact missing-await bug against
  //        the real (async, Promise-returning) PentaEmployees.get shape,
  //        and proves the shipped builder no longer has it. The old
  //        code was: `var emp = window.PentaEmployees.get(uuid); return
  //        {pay_rate: emp ? emp.payRate : null, ...}` -- no await. Since
  //        `get()` is async, `emp` was always the pending Promise object
  //        (truthy), so emp.payRate read as undefined every time,
  //        regardless of what the real employee record held. ──
  {
    const fakeGetOldWay = function (uuid) { return Promise.resolve({ payRate: 20, pay_type: 'hourly' }); };
    const emp = fakeGetOldWay('alice-uuid'); // deliberately NOT awaited, exactly like the old bug
    const oldBuggyResult = { pay_rate: emp ? emp.payRate : null, pay_type: emp ? emp.pay_type : null };
    check('OLD pattern (no await) reproduces the bug: pay_rate reads as undefined off the Promise', oldBuggyResult.pay_rate, undefined);
    check('OLD pattern (no await) reproduces the bug: pay_type reads as undefined off the Promise', oldBuggyResult.pay_type, undefined);

    // Now run the REAL, SHIPPED _vsnapBuildTeamDay end-to-end with a
    // real async get() in the sandbox (per buildSandbox's own stub) and
    // confirm the written row has the CORRECT rate -- this is the test
    // that fails against the old source and passes against the new.
    const store = {};
    const fakeSb = makeFakeSupabase(store);
    const sandbox = buildSandbox({
      bid: 'biz-1', fakeSupabase: fakeSb,
      jobs: [{ id: 'jobR', date: '2026-11-01', team: 'B1', clientId: 'cR', cancelled: false }],
      teamHoursEligibility: function () { return { included: [{ id: 'alice', uuid: 'alice-uuid', pay_rate: 20, pay_type: 'hourly' }], skipped: [] }; },
      fetchTeamDayGpsDetail: function () { return Promise.resolve({ device: { id: 'd1' }, trips: [{}], stopList: [{ isDepot: false, lat: 1, lng: 1, addr: 'X', inTime: new Date('2026-11-01T14:00:00Z'), outTime: new Date('2026-11-01T14:30:00Z') }] }); },
      matchStopToClientGeo: function (lat, lng, addr) { return addr === 'X' ? { id: 'cR' } : null; }
    });
    const sbCtx = { sb: fakeSb, bid: 'biz-1', userId: 'user-1' };
    const counts = { matched: 0, ambiguous: 0, no_gps: 0, unmatched: 0, skipped: 0, alreadyBuilt: 0, incompleteLaborCost: 0, writeErrors: 0 };
    await sandbox._vsnapBuildTeamDay(sbCtx, 'B1', '2026-11-01', false, counts);
    const row = store.job_visit_snapshots[0];
    check('REGRESSION: shipped builder resolves the real rate (2000 cents), not null', row.employees[0].rate_cents_per_hour, 2000);
    check('REGRESSION: labor_cost_complete is true (not falsely incomplete)', row.labor_cost_complete, true);
  }

  // ── 10c. Rate-state matrix on the roster row itself (hourly+rate,
  //        salaried, null rate, zero rate, unknown employee) ──
  {
    function runOneEmployee(rosterEmp, label) {
      return (async function () {
        const store = {};
        const fakeSb = makeFakeSupabase(store);
        const sandbox = buildSandbox({
          bid: 'biz-1', fakeSupabase: fakeSb,
          jobs: [{ id: 'job-' + label, date: '2026-11-01', team: 'B1', clientId: 'c-' + label, cancelled: false }],
          teamHoursEligibility: function () { return { included: [rosterEmp], skipped: [] }; },
          fetchTeamDayGpsDetail: function () { return Promise.resolve({ device: { id: 'd1' }, trips: [{}], stopList: [{ isDepot: false, lat: 1, lng: 1, addr: 'X', inTime: new Date('2026-11-01T14:00:00Z'), outTime: new Date('2026-11-01T14:30:00Z') }] }); },
          matchStopToClientGeo: function () { return { id: 'c-' + label }; }
        });
        const sbCtx = { sb: fakeSb, bid: 'biz-1', userId: 'user-1' };
        const counts = { matched: 0, ambiguous: 0, no_gps: 0, unmatched: 0, skipped: 0, alreadyBuilt: 0, incompleteLaborCost: 0, writeErrors: 0 };
        await sandbox._vsnapBuildTeamDay(sbCtx, 'B1', '2026-11-01', false, counts);
        return store.job_visit_snapshots[0];
      })();
    }

    const hourly = await runOneEmployee({ id: 'e1', uuid: 'e1-uuid', pay_rate: 18, pay_type: 'hourly' }, 'hourly');
    check('hourly with rate: included, 1800 cents/hr', hourly.employees[0].rate_cents_per_hour, 1800);
    check('hourly with rate: labor_cost_complete true', hourly.labor_cost_complete, true);

    const salaried = await runOneEmployee({ id: 'e2', uuid: 'e2-uuid', pay_rate: 18, pay_type: 'salary' }, 'salaried');
    check('salaried: excluded from sum (null rate in jsonb)', salaried.employees[0].rate_cents_per_hour, null);
    check('salaried: labor_cost_complete false', salaried.labor_cost_complete, false);
    check('salaried: labor_cost_gross_cents null (nobody ratable)', salaried.labor_cost_gross_cents, null);

    const nullRate = await runOneEmployee({ id: 'e3', uuid: 'e3-uuid', pay_rate: null, pay_type: 'hourly' }, 'nullrate');
    check('null rate: excluded from sum', nullRate.employees[0].rate_cents_per_hour, null);
    check('null rate: labor_cost_complete false', nullRate.labor_cost_complete, false);

    const zeroRate = await runOneEmployee({ id: 'e4', uuid: 'e4-uuid', pay_rate: 0, pay_type: 'hourly' }, 'zerorate');
    check('zero rate: excluded from sum (defensive check even if upstream let a zero through)', zeroRate.employees[0].rate_cents_per_hour, null);
    check('zero rate: labor_cost_complete false', zeroRate.labor_cost_complete, false);

    // Unknown employee: _teamHoursEmpUuid resolves to nothing (no uuid,
    // no id) -- must never be silently dropped. labor_cost_complete is
    // forced false and a visible match_note is added, never a blank one.
    const unknown = await runOneEmployee({}, 'unknown');
    check('unknown employee: dropped from the employees array (no id to key it by)', unknown.employees.length, 0);
    check('unknown employee: labor_cost_complete forced false', unknown.labor_cost_complete, false);
    checkTrue('unknown employee: match_note visibly says so, never silent', /could not be matched/.test(unknown.match_note || ''));
  }

  // ── 11. Completion signal: _vsnapRun skips dates >= today, never calls the builder for them ──
  {
    const calledDates = [];
    const sandbox = buildSandbox({
      today: { y: 2026, m: 11, d: 10 }, // "today" is 2026-11-10
      document: (function () {
        const els = {
          'vsnap-from': { value: '2026-11-07' }, 'vsnap-to': { value: '2026-11-11' }, // spans two past days, today, and one day past
          'vsnap-status': { style: {}, textContent: '' }, 'vsnap-summary': { innerHTML: '' },
          'vsnap-run-btn': { disabled: false, textContent: 'Build' }, 'vsnap-rebuild-matched': { checked: false }
        };
        return { getElementById: function (id) { return els[id] || null; }, _els: els };
      })()
    });
    sandbox._vsnapBuildTeamDay = function (sbCtx, team, dateStr) { calledDates.push(dateStr); return Promise.resolve(); };
    sandbox._vsnapGetCurrentWriter = function () { return Promise.resolve({ sb: {}, bid: 'biz-1', userId: 'u1' }); };
    await sandbox._vsnapRun();
    check('all three past dates (11-07..11-09) were built; today and tomorrow were skipped', calledDates, ['2026-11-07', '2026-11-08', '2026-11-09']);
    checkTrue('status mentions "Done"', /Done/.test(sandbox.document._els['vsnap-status'].textContent));
  }

  // ── 12. 31-day cap shows the real error and never reaches the builder ──
  {
    const calledDates = [];
    const sandbox = buildSandbox({
      document: (function () {
        const els = {
          'vsnap-from': { value: '2026-01-01' }, 'vsnap-to': { value: '2026-03-01' }, // ~60 days, over the cap
          'vsnap-status': { style: {}, textContent: '' }, 'vsnap-summary': { innerHTML: '' },
          'vsnap-run-btn': { disabled: false, textContent: 'Build' }, 'vsnap-rebuild-matched': { checked: false }
        };
        return { getElementById: function (id) { return els[id] || null; }, _els: els };
      })()
    });
    sandbox._vsnapBuildTeamDay = function (sbCtx, team, dateStr) { calledDates.push(dateStr); return Promise.resolve(); };
    sandbox._vsnapGetCurrentWriter = function () { return Promise.resolve({ sb: {}, bid: 'biz-1', userId: 'u1' }); };
    await sandbox._vsnapRun();
    checkTrue('status shows the 31-day cap message', /31 days or fewer/.test(sandbox.document._els['vsnap-status'].textContent));
    check('builder was never called', calledDates, []);
  }

  // ── 13. One failed day does not stop the others ──
  {
    const processed = [];
    const sandbox = buildSandbox({
      today: { y: 2026, m: 11, d: 20 },
      document: (function () {
        const els = {
          'vsnap-from': { value: '2026-11-01' }, 'vsnap-to': { value: '2026-11-03' },
          'vsnap-status': { style: {}, textContent: '' }, 'vsnap-summary': { innerHTML: '' },
          'vsnap-run-btn': { disabled: false, textContent: 'Build' }, 'vsnap-rebuild-matched': { checked: false }
        };
        return { getElementById: function (id) { return els[id] || null; }, _els: els };
      })(),
      teams: ['B1']
    });
    sandbox._vsnapBuildTeamDay = function (sbCtx, team, dateStr) {
      if (dateStr === '2026-11-02') return Promise.reject(new Error('Geotab outage'));
      processed.push(dateStr);
      return Promise.resolve();
    };
    sandbox._vsnapGetCurrentWriter = function () { return Promise.resolve({ sb: {}, bid: 'biz-1', userId: 'u1' }); };
    await sandbox._vsnapRun();
    check('the other two days still processed despite the middle day failing', processed, ['2026-11-01', '2026-11-03']);
    checkTrue('status reports one day could not load', /1 day\(s\) could not load/.test(sandbox.document._els['vsnap-status'].textContent));
  }

  // ── 14. Visibility matrix: Files grid only shows "Visit Data" to owner/admin ──
  {
    const cases = [
      { role: 'owner', expectVisible: true }, { role: 'admin', expectVisible: true },
      { role: 'manager', expectVisible: false }, { role: 'dispatcher', expectVisible: false },
      { role: 'employee', expectVisible: false }, { role: null, expectVisible: false } // null = logged-out
    ];
    cases.forEach(function (c) {
      const grid = { innerHTML: '' };
      const sandbox = buildSandbox({ role: c.role, document: { getElementById: function (id) { return id === 'files-grid' ? grid : null; } } });
      sandbox.renderFilesGrid();
      check('Files grid "Visit Data" visibility for role=' + c.role, /openVisitDataTool/.test(grid.innerHTML), c.expectVisible);
      // Team Day Report's own, wider gate (owner/admin/manager) must be completely unaffected by this change.
      const expectTdrVisible = ['owner', 'admin', 'manager'].indexOf(c.role) !== -1;
      check('Files grid "Team Day Report" visibility unaffected for role=' + c.role, /openTeamDayReport/.test(grid.innerHTML), expectTdrVisible);
    });
  }

  // ── 15. openVisitDataTool itself refuses non-owner/admin roles, no overlay created ──
  {
    ['manager', 'dispatcher', 'employee', null].forEach(function (role) {
      let alerted = false;
      const body = { appendChild: function () { throw new Error('must not create an overlay for role=' + role); } };
      const sandbox = buildSandbox({ role: role, alertFn: function () { alerted = true; }, document: { getElementById: function () { return null; }, body: body } });
      sandbox.document.body = body;
      sandbox.openVisitDataTool();
      checkTrue('openVisitDataTool alerts and refuses for role=' + role, alerted);
    });
    // owner/admin: overlay IS appended, no alert.
    ['owner', 'admin'].forEach(function (role) {
      let appended = null;
      let alerted = false;
      const sandbox = buildSandbox({
        role: role, alertFn: function () { alerted = true; },
        document: {
          getElementById: function () { return null; },
          createElement: function () { return { style: {} }; },
          body: { appendChild: function (el) { appended = el; } }
        }
      });
      sandbox.openVisitDataTool();
      checkTrue('openVisitDataTool opens for role=' + role, appended && !alerted);
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
