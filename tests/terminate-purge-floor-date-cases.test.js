// Terminate flow fix (C) -- unassignFutureForEmployee's purge floor,
// against the REAL extracted function. Covers the exact three cases
// the spec asked for: termination date D in the past, today, and in
// the future. In every case, a row dated TODAY or earlier must never
// be soft-deleted, even when D itself is backdated well into the past.
//
// _bizTodayParts/_pentaBusinessTimezone are mocked to a FIXED "today"
// (2026-10-19) so this test is deterministic regardless of when it's
// actually run.
//
// Run with: node tests/terminate-purge-floor-date-cases.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e + endMarker.length);
}

const fnSource = extract(
  'async function unassignFutureForEmployee(employeeId, fromDate) {',
  '\n  }\n',
  'unassignFutureForEmployee'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const TODAY = '2026-10-19'; // fixed "today" for this test

// A realistic spread of daily_assignments rows for one employee: some
// well in the past, one dated exactly today, and some in the future.
function freshCache() {
  return [
    { id: 'row-1', employee_id: 'db-emp-1', date: '2026-09-01', deleted_at: null },
    { id: 'row-2', employee_id: 'db-emp-1', date: '2026-10-10', deleted_at: null },
    { id: 'row-3', employee_id: 'db-emp-1', date: TODAY, deleted_at: null },           // today
    { id: 'row-4', employee_id: 'db-emp-1', date: '2026-10-20', deleted_at: null },    // tomorrow
    { id: 'row-5', employee_id: 'db-emp-1', date: '2026-10-25', deleted_at: null },    // further future
    { id: 'row-6', employee_id: 'db-emp-1', date: '2026-11-15', deleted_at: null },    // further future
  ];
}

function buildSandbox(cache) {
  const updateCalls = [];
  const sandbox = {
    console,
    SB: () => ({
      from: (table) => ({
        update: (patch) => ({
          eq: (col1, val1) => ({
            gte: (col2, val2) => ({
              is: (col3, val3) => {
                updateCalls.push({ table, patch, eqCol: col1, eqVal: val1, gteCol: col2, gteVal: val2, isCol: col3, isVal: val3 });
                return Promise.resolve({ error: null });
              },
            }),
          }),
        }),
      }),
    }),
    _resolveEmployeeId: (id) => Promise.resolve('db-emp-1'),
    _currentUserId: () => Promise.resolve('manager-uuid-1'),
    _cache: cache,
    _rebuildIndex: () => {},
    _notify: () => {},
    // Fixed "today" so this test is deterministic.
    _bizTodayParts: () => ({ y: 2026, m: 10, d: 19 }),
    _pentaBusinessTimezone: () => 'America/New_York',
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, updateCalls };
}

async function main() {
  // ---- D in the past (Sep 15): only rows dated AFTER today (Oct 19) are purged, nothing today-or-earlier ----
  {
    const cache = freshCache();
    const { sandbox, updateCalls } = buildSandbox(cache);
    const removed = await sandbox.unassignFutureForEmployee('e-1', '2026-09-15');
    const remainingDates = sandbox._cache.map((r) => r.date).sort();
    check('a backdated D does NOT purge Sep 1 (real past history, long before D)', remainingDates.includes('2026-09-01'), true);
    check('a backdated D does NOT purge Oct 10 (real past history, between D and today)', remainingDates.includes('2026-10-10'), true);
    check('a backdated D does NOT purge TODAY (2026-10-19), even though D is in the past', remainingDates.includes(TODAY), true);
    check('a backdated D DOES purge tomorrow (2026-10-20) onward', remainingDates.includes('2026-10-20'), false);
    check('a backdated D DOES purge further-future rows too', remainingDates.includes('2026-10-25') || remainingDates.includes('2026-11-15'), false);
    check('exactly 3 rows removed (2026-10-20, 2026-10-25, 2026-11-15) -- today and all real past rows survive', removed, 3);
    check('the real DB update query uses tomorrow as its floor, not the backdated D', updateCalls[0].gteVal, '2026-10-20');
  }

  // ---- D is today (2026-10-19): identical outcome -- today itself is never purged ----
  {
    const cache = freshCache();
    const { sandbox } = buildSandbox(cache);
    const removed = await sandbox.unassignFutureForEmployee('e-1', TODAY);
    const remainingDates = sandbox._cache.map((r) => r.date).sort();
    check('D = today does not purge today itself', remainingDates.includes(TODAY), true);
    check('D = today does not purge real past history', remainingDates.includes('2026-09-01') && remainingDates.includes('2026-10-10'), true);
    check('D = today still purges tomorrow onward', remainingDates.includes('2026-10-20'), false);
    check('exactly 3 rows removed', removed, 3);
  }

  // ---- D in the future (2026-11-01): purges from D itself -- those days have not happened yet ----
  {
    const cache = freshCache();
    const { sandbox, updateCalls } = buildSandbox(cache);
    const removed = await sandbox.unassignFutureForEmployee('e-1', '2026-11-01');
    const remainingDates = sandbox._cache.map((r) => r.date).sort();
    check('a future D does not touch today or earlier', remainingDates.includes(TODAY) && remainingDates.includes('2026-10-10'), true);
    check('a future D still leaves the transition period (today..D-1) alone -- e.g. Oct 20/25 survive, they are before D', remainingDates.includes('2026-10-20') && remainingDates.includes('2026-10-25'), true);
    check('a future D purges Nov 15 (on/after D itself)', remainingDates.includes('2026-11-15'), false);
    check('exactly 1 row removed (only 2026-11-15, the one row on/after D)', removed, 1);
    check('the real DB update query uses D itself as its floor (future D is not delayed)', updateCalls[0].gteVal, '2026-11-01');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
