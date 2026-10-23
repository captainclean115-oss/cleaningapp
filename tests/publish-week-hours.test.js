// Published Hours feature -- unit tests for publishWeekHours() itself,
// extracting and running the ACTUAL function from index.html (plus
// _toInstant/_isUuidLike, its own small helpers). resolveEmployeeDayHours
// is stubbed per-scenario here (its own arithmetic is already proven in
// tests/resolve-employee-day-hours-equivalence.test.js) -- this file's
// job is publishWeekHours's OWN orchestration: who gets a row, under
// what status/source, and -- the privacy/safety requirement from the PR
// #198 review -- that an unresolved ambiguous zero is SKIPPED, never
// published as a fake "worked 0 hours" day.
//
// Run with: node tests/publish-week-hours.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed: could not find start marker (' + label + '): ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed: could not find end marker after start (' + label + '): ' + endMarker);
  return src.slice(s, e);
}

const publishSrc = extract(
  "function _toInstant(dayDate, hhmm) {",
  "\nfunction _updatePublishIndicator",
  'publishWeekHours + helpers'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function dk(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// _isUuidLike requires a real 8-4-4-4-12 hex UUID shape -- plain test
// labels like "elvia-uuid" would be treated as unresolvable and skipped
// entirely (exactly the guard that protects a real malformed row from
// ever being published), so these fixtures use real UUID shapes.
const ELVIA_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINDA_UUID = 'aaaaaaaa-0000-4000-8000-000000000002';
const PAT_UUID = 'aaaaaaaa-0000-4000-8000-000000000003';
const ROSA_UUID = 'aaaaaaaa-0000-4000-8000-000000000004';

const ROSTER = [
  // Payroll cost tally feature: pay_rate added to exercise est_rate/
  // est_gross snapshotting. Pat (salaried) and Rosa (no rate on file)
  // deliberately left without one -- salaried never gets an estimate;
  // no-rate must publish with est_rate/est_gross both null, never 0.
  { id: 'elvia-legacy', uuid: ELVIA_UUID, name: 'Elvia', work_type: 'field', status: 'active', pay_rate: 20 },
  { id: 'linda-legacy', uuid: LINDA_UUID, name: 'Linda', work_type: 'admin', pay_type: 'hourly', status: 'active', pay_rate: 15 },
  { id: 'pat-legacy', uuid: PAT_UUID, name: 'Pat', work_type: 'admin', pay_type: 'salary', status: 'active' },
  // Rosa: terminated effective 2026-08-19 -- present for Mon/Tue (before),
  // excluded Wed/Thu/Fri (on/after), same isTerminatedAsOf rule getUnifiedRoster uses.
  { id: 'rosa-legacy', uuid: ROSA_UUID, name: 'Rosa', work_type: 'field', status: 'terminated', terminated_at: '2026-08-19' },
];

// Per-day, per-employee resolveEmployeeDayHours() stand-ins -- one entry
// per (empId, dateKey) actually exercised by the scenarios below.
const RD_FIXTURES = {
  // Elvia Mon Aug17 -- vehicle-swap day (team_device_assignments override
  // put her on S3 instead of her default team that day).
  'elvia-legacy|2026-08-17': { dayTeam: 'S3', isOff: false, hours: 5.5, startDate: new Date('2026-08-17T13:00:00.000Z'), endDate: new Date('2026-08-17T18:30:00.000Z'), lunchMin: 30, isOverride: false },
  // Elvia Tue Aug18 -- shift starts before and ends after UTC midnight.
  'elvia-legacy|2026-08-18': { dayTeam: 'B1', isOff: false, hours: 6, startDate: new Date('2026-08-19T03:30:00.000Z'), endDate: new Date('2026-08-19T09:30:00.000Z'), lunchMin: 0, isOverride: false },
  // Elvia Wed Aug19 -- OFF, vacation category.
  'elvia-legacy|2026-08-19': { dayTeam: null, isOff: true, hours: 0, startDate: null, endDate: null, lunchMin: 0, isOverride: false },
  // Elvia Thu Aug20 -- unresolved ambiguous zero (no override, no
  // personal cell, team source is time_entries) -- must be SKIPPED.
  'elvia-legacy|2026-08-20': { dayTeam: 'B1', isOff: false, hours: 0, startDate: null, endDate: null, lunchMin: 0, isOverride: false },
  // Elvia Fri Aug21 -- a REAL override of 0 hours (deliberate manager
  // entry) -- must still publish, unlike the ambiguous zero above.
  'elvia-legacy|2026-08-21': { dayTeam: 'B1', isOff: false, hours: 0, startDate: null, endDate: null, lunchMin: 0, isOverride: true },
  // Rosa Mon/Tue -- a normal worked day, published for dates before her
  // termination (the roster fixture above already excludes her after).
  'rosa-legacy|2026-08-17': { dayTeam: 'B2', isOff: false, hours: 8, startDate: new Date('2026-08-17T13:00:00.000Z'), endDate: new Date('2026-08-17T21:00:00.000Z'), lunchMin: 0, isOverride: false },
  'rosa-legacy|2026-08-18': { dayTeam: 'B2', isOff: false, hours: 8, startDate: new Date('2026-08-18T13:00:00.000Z'), endDate: new Date('2026-08-18T21:00:00.000Z'), lunchMin: 0, isOverride: false },
};

function buildSandbox(opts) {
  opts = opts || {};
  const upsertCalls = [];
  const existingRows = opts.existingRows || [];

  const sandbox = {
    console: console,
    window: {
      supabaseClient: {
        from: function (table) {
          if (table === 'business_payroll_settings') {
            // Payroll cost tally feature: overtime toggle controlled per
            // test via opts.overtimeEnabled -- defaults off.
            const pbuilder = {
              select: function () { return pbuilder; },
              eq: function () { return pbuilder; },
              maybeSingle: function () { return Promise.resolve({ data: { overtime_enabled: !!opts.overtimeEnabled }, error: null }); },
            };
            return pbuilder;
          }
          if (table !== 'published_employee_hours') throw new Error('UNEXPECTED QUERY to table "' + table + '"');
          const builder = {
            select: function () { return builder; },
            eq: function () { return builder; },
            gte: function () { return builder; },
            lte: function () { return Promise.resolve({ data: existingRows, error: null }); },
            upsert: function (rows, conflictOpts) {
              upsertCalls.push({ rows: rows, conflictOpts: conflictOpts });
              return Promise.resolve({ error: opts.upsertError || null });
            },
          };
          return builder;
        },
      },
      PentaTenant: { current: function () { return 'biz-1'; } },
      PentaAuth: { session: { user: { id: 'manager-uuid' } } },
    },
    dateKey: dk,
    getWeekDates: function (offset) {
      // Fixed Mon Aug17..Fri Aug21 2026 regardless of offset -- tests
      // call publishWeekHours with an explicit days[] anyway; only
      // _weekOffsetForDate (not exercised in this file) uses offset 0.
      return [17, 18, 19, 20, 21].map(function (day) { return new Date(2026, 7, day); });
    },
    getUnifiedRoster: function (asOfDate) {
      return ROSTER.filter(function (e) {
        if (e.status !== 'terminated') return true;
        return !(e.terminated_at && asOfDate >= e.terminated_at);
      });
    },
    isSalariedAdmin: function (emp) { return emp.work_type === 'admin' && emp.pay_type === 'salary'; },
    _adminEmpDayOff: function () { return null; }, // Linda never OFF in these fixtures
    getEmpHours: function (empId, dateStr) {
      if (empId === 'linda-legacy' && dateStr === '2026-08-17') return { hours: 7, start: '09:00', end: '16:00', lunch: 0 };
      return null;
    },
    resolveEmployeeDayHours: function (empId, d, dayIdx, weekHoursData, empHoursMapData) {
      const key = empId + '|' + dk(d);
      return RD_FIXTURES[key] || { dayTeam: null, isOff: true, hours: 0, startDate: null, endDate: null, lunchMin: 0, isOverride: false };
    },
    getEmployeeDayOffInfo: function (empId, dateStr) {
      if (empId === 'elvia-legacy' && dateStr === '2026-08-19') return { status_type: 'vacation' };
      return null;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(publishSrc, sandbox);
  return { sandbox: sandbox, upsertCalls: upsertCalls };
}

(async function () {
  console.log('Testing extracted publishWeekHours() from index.html\n');

  const days = [17, 18, 19, 20, 21].map(function (day) { return new Date(2026, 7, day); });

  const { sandbox, upsertCalls } = buildSandbox({});
  const result = await sandbox.publishWeekHours(days, {}, {});

  const writtenByKey = {};
  upsertCalls.forEach(function (c) { c.rows.forEach(function (r) { writtenByKey[r.employee_id + '|' + r.work_date] = r; }); });

  // Vehicle-swap day.
  {
    const row = writtenByKey[ELVIA_UUID + '|2026-08-17'];
    check('vehicle-swap day: published under the SWAPPED team, not the default', row && row.team_label, 'S3');
    check('vehicle-swap day: hours match resolveEmployeeDayHours exactly', row && row.hours, 5.5);
    check('vehicle-swap day: lunch carries through', row && row.lunch_minutes, 30);
    check('vehicle-swap day: source is gps (not an override)', row && row.source, 'gps');
  }

  // Midnight-UTC-crossing shift.
  {
    const row = writtenByKey[ELVIA_UUID + '|2026-08-18'];
    check('midnight-UTC day: start_time is the real instant, unshifted', row && row.start_time, '2026-08-19T03:30:00.000Z');
    check('midnight-UTC day: end_time is the real instant, unshifted', row && row.end_time, '2026-08-19T09:30:00.000Z');
  }

  // OFF / vacation.
  {
    const row = writtenByKey[ELVIA_UUID + '|2026-08-19'];
    check('OFF day with vacation category publishes status=vacation', row && row.status, 'vacation');
    check('OFF day publishes zero hours, no start/end', row && [row.hours, row.start_time, row.end_time], [0, null, null]);
  }

  // Unresolved ambiguous zero -- must be SKIPPED, never published.
  {
    const row = writtenByKey[ELVIA_UUID + '|2026-08-20'];
    check('an unresolved zero (no override, no GPS data) is never published', row, undefined);
  }

  // A REAL override of 0 -- must still publish.
  {
    const row = writtenByKey[ELVIA_UUID + '|2026-08-21'];
    check('an explicit manager override of 0 hours still publishes (deliberate, not ambiguous)', row && row.status, 'worked');
    check('override-of-zero: source is override', row && row.source, 'override');
  }

  // Salaried admin.
  {
    const row = writtenByKey[PAT_UUID + '|2026-08-17'];
    check('salaried admin publishes status=salaried with no hours', row && [row.status, row.hours, row.team_label], ['salaried', null, null]);
  }

  // Hourly admin -- manual override only, no team/vehicle language.
  {
    const row = writtenByKey[LINDA_UUID + '|2026-08-17'];
    check('hourly admin: manual override hours published', row && row.hours, 7);
    check('hourly admin: team_label is null (no team/vehicle language)', row && row.team_label, null);
    check('hourly admin: source is manual', row && row.source, 'manual');
  }
  {
    // Linda has no override on Aug 18 in the fixture -- nothing to publish.
    const row = writtenByKey[LINDA_UUID + '|2026-08-18'];
    check('hourly admin with no override on file: no row published (not a fake zero)', row, undefined);
  }

  // Terminated-before-date: Rosa still publishes for Mon/Tue (before her
  // 2026-08-19 termination), and is simply absent from the roster (never
  // an explicit delete) for Wed onward.
  {
    const mon = writtenByKey[ROSA_UUID + '|2026-08-17'];
    const tue = writtenByKey[ROSA_UUID + '|2026-08-18'];
    check('terminated employee: still publishes for a date BEFORE her termination date', mon && mon.hours, 8);
    check('terminated employee: still publishes the day before termination too', tue && tue.hours, 8);
    check('terminated employee: no row attempted for her termination date or after (never in the roster for those days)', Object.keys(writtenByKey).some(function (k) { return k.indexOf(ROSA_UUID + '|2026-08-19') === 0 || k.indexOf(ROSA_UUID + '|2026-08-20') === 0 || k.indexOf(ROSA_UUID + '|2026-08-21') === 0; }), false);
  }

  // Payroll cost tally feature: est_rate/est_gross snapshotting.
  {
    const elviaMon = writtenByKey[ELVIA_UUID + '|2026-08-17']; // 5.5h, $20/hr, overtime off
    check('est_rate snapshots the roster\'s pay_rate at publish time', elviaMon && elviaMon.est_rate, 20);
    check('est_gross is cents, computed from hours*rate (overtime off by default)', elviaMon && elviaMon.est_gross, Math.round(5.5 * 20 * 100));

    const lindaMon = writtenByKey[LINDA_UUID + '|2026-08-17']; // 7h override, $15/hr
    check('hourly admin also gets est_rate/est_gross from the same snapshot', lindaMon && lindaMon.est_rate, 15);
    check('hourly admin est_gross', lindaMon && lindaMon.est_gross, Math.round(7 * 15 * 100));

    const rosaMon = writtenByKey[ROSA_UUID + '|2026-08-17']; // no pay_rate on the roster fixture
    check('no pay_rate on file: est_rate is null, never a fake value', rosaMon && rosaMon.est_rate, null);
    check('no pay_rate on file: est_gross is null, never a fake $0', rosaMon && rosaMon.est_gross, null);

    const elviaOffDay = writtenByKey[ELVIA_UUID + '|2026-08-19']; // OFF/vacation day
    check('an OFF day never gets an est_gross even though Elvia has a rate', elviaOffDay && elviaOffDay.est_rate, null);
  }

  check('total published count matches the number of actual upserted rows', result.published, upsertCalls.reduce(function (s, c) { return s + c.rows.length; }, 0));

  // Diff-check: re-publishing the SAME week with nothing changed writes
  // nothing new, and published_at (simulated via "no upsert call") never
  // moves for unchanged rows.
  {
    const existingRows = upsertCalls.length ? upsertCalls[0].rows.concat(upsertCalls[1] ? upsertCalls[1].rows : []) : [];
    const { sandbox: sandbox2, upsertCalls: upsertCalls2 } = buildSandbox({ existingRows: existingRows });
    const result2 = await sandbox2.publishWeekHours(days, {}, {});
    check('re-publishing an unchanged week writes zero rows', result2.published, 0);
    check('re-publishing an unchanged week makes no upsert call at all', upsertCalls2.length, 0);
  }

  // Payroll cost tally feature: a PURE pay-rate change (identical hours,
  // different est_rate/est_gross) must still trigger a rewrite through
  // the existing diff-check -- no separate "Republish week" button
  // needed, a rate change alone is enough.
  {
    const priorRows = (upsertCalls[0] ? upsertCalls[0].rows : []).concat(upsertCalls[1] ? upsertCalls[1].rows : []);
    const staleRate = priorRows.map(function (r) {
      return Object.assign({}, r, { est_rate: r.est_rate != null ? r.est_rate + 5 : null, est_gross: r.est_gross != null ? r.est_gross + 12345 : null });
    });
    const { sandbox: sandbox4, upsertCalls: upsertCalls4 } = buildSandbox({ existingRows: staleRate });
    const result4 = await sandbox4.publishWeekHours(days, {}, {});
    check('a pure rate change (hours identical, est_rate/est_gross stale) triggers a republish', result4.published > 0, true);
  }

  // A changed value DOES get rewritten even when a row already exists.
  {
    const existingRows = [{ employee_id: 'elvia-uuid', work_date: '2026-08-17', hours: 999, start_time: null, end_time: null, lunch_minutes: null, team_label: 'WRONG', status: 'worked', source: 'gps' }];
    const { sandbox: sandbox3, upsertCalls: upsertCalls3 } = buildSandbox({ existingRows: existingRows });
    await sandbox3.publishWeekHours(days, {}, {});
    const writtenByKey3 = {};
    upsertCalls3.forEach(function (c) { c.rows.forEach(function (r) { writtenByKey3[r.employee_id + '|' + r.work_date] = r; }); });
    check('a row whose value actually changed since last publish IS rewritten', writtenByKey3[ELVIA_UUID + '|2026-08-17'] && writtenByKey3[ELVIA_UUID + '|2026-08-17'].hours, 5.5);
  }

  // A publish-step failure (the upsert itself erroring) must surface as
  // a thrown error, never a silently-swallowed "success".
  {
    const { sandbox: sandbox4 } = buildSandbox({ upsertError: { message: 'simulated write failure' } });
    let threw = false;
    try { await sandbox4.publishWeekHours(days, {}, {}); } catch (e) { threw = true; }
    check('an upsert failure throws (the manager-facing caller shows a visible warning)', threw, true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
