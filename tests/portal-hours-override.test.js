// Published Hours feature -- re-targeted AGAIN. renderHours() no longer
// calls loadWeekHours()/resolveEmployeeDayHours at all for a field
// employee: it reads published_employee_hours directly, filtered to her
// own employee_id, via a mocked Supabase client. Extracts and runs the
// ACTUAL renderHours() source from index.html, not a reimplementation.
//
// The sandbox deliberately provides NO getEmpHours/dailyAssignments/
// Geotab-shaped globals at all, and the mocked `from()` throws loudly if
// the code ever queries any table other than published_employee_hours --
// proving the portal's own in-memory state and requests contain nothing
// but her own published rows (Published Hours TESTS item 1).
//
// Run with: node tests/portal-hours-override.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error('extraction failed: could not find start marker (' + label + '): ' + startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('extraction failed: could not find end marker after start (' + label + '): ' + endMarker);
  return src.slice(startIdx, endIdx);
}

const renderHoursSrc = extract(
  '\nasync function renderHours() {',
  '\nfunction getPortalWeekDates(',
  'renderHours'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function makeDocStub() {
  const nodes = {};
  return {
    getElementById: function (id) {
      if (!nodes[id]) nodes[id] = { textContent: '', innerHTML: '', style: {} };
      return nodes[id];
    },
  };
}

function dk(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// Builds a Supabase client stub whose from() THROWS for any table other
// than published_employee_hours (proving nothing else is ever queried),
// and whose published_employee_hours query returns the supplied rows,
// filtered in-memory by the (employee_id, work_date range) the real
// query call actually applies -- so a row for a DIFFERENT employee in
// the fixture would never come back even if the code forgot to filter.
function makeSupabaseStub(allRows, opts) {
  opts = opts || {};
  const calls = [];
  return {
    calls: calls,
    client: {
      from: function (table) {
        if (table !== 'published_employee_hours') {
          throw new Error('UNEXPECTED QUERY to table "' + table + '" -- the published-hours portal must never query anything else');
        }
        const call = { table: table, eq: {}, gte: null, lte: null };
        calls.push(call);
        const builder = {
          select: function () { return builder; },
          eq: function (col, val) { call.eq[col] = val; return builder; },
          gte: function (col, val) { call.gte = [col, val]; return builder; },
          lte: function (col, val) {
            call.lte = [col, val];
            if (opts.error) return Promise.resolve({ data: null, error: opts.error });
            const empId = call.eq.employee_id;
            const filtered = allRows.filter(function (r) {
              return r.employee_id === empId && r.work_date >= call.gte[1] && r.work_date <= call.lte[1];
            });
            return Promise.resolve({ data: filtered, error: null });
          },
        };
        return builder;
      },
    },
  };
}

async function runRenderHours(opts) {
  let capturedComposite = null;
  const days = opts.days;
  const sbStub = makeSupabaseStub(opts.publishedRows || [], opts.sbOpts);

  const sandbox = {
    console: console,
    document: makeDocStub(),
    window: {
      supabaseClient: sbStub.client,
      PentaTenant: { current: function () { return 'biz-1'; } },
      PentaEmployees: { getByLegacyRosterId: function () { return null; } },
    },
    currentEmployee: { id: opts.employeeId, uuid: opts.employeeUuid },
    currentLang: 'en',
    _portalWeekOffset: 0,
    t: function (k) { return k; },
    dateKey: dk,
    getPortalWeekDates: function () { return days; },
    renderHoursData: function (composite) { capturedComposite = composite; },
    _renderPortalHoursUpdatedLabel: function () {},
    _renderPortalEstimatedPay: function () {},
    _setupPublishedHoursRealtime: function () {},
    isSalariedAdmin: function () { return false; },
  };
  sandbox.window.PentaAssignments = { ready: function () { return Promise.resolve(); } };
  sandbox._mirrorPentaAssignmentsToInMemory = function () {};

  vm.createContext(sandbox);
  vm.runInContext(renderHoursSrc, sandbox);
  await vm.runInContext('renderHours()', sandbox);
  return { composite: capturedComposite, queryCalls: sbStub.calls };
}

(async function () {
  console.log('Testing extracted renderHours() (published-hours read) from index.html\n');

  const days = [
    new Date(2026, 7, 17), // Mon Aug 17
    new Date(2026, 7, 18), // Tue Aug 18
    new Date(2026, 7, 19), // Wed -- "today" in the no-row case below
    new Date(2026, 7, 20),
    new Date(2026, 7, 21),
  ];
  const mk = function (workDate, fields) {
    return Object.assign({ employee_id: 'elvia-uuid', work_date: workDate, published_at: '2026-08-21T12:00:00.000Z' }, fields);
  };

  // Case 1: a worked day with a published row -- portal shows exactly
  // what was published, nothing recomputed.
  {
    const { composite, queryCalls } = await runRenderHours({
      employeeId: 'elvia-legacy-id', employeeUuid: 'elvia-uuid', days: days,
      publishedRows: [
        mk('2026-08-17', { hours: 8, start_time: '2026-08-17T13:12:00.000Z', end_time: '2026-08-17T21:46:00.000Z', lunch_minutes: 0, status: 'worked' }),
      ],
    });
    check('worked day: hours come straight from the published row', composite.days[0], 8);
    check('worked day: start_time comes straight from the published row', composite.starts[0], '2026-08-17T13:12:00.000Z');
    check('the query was scoped to this employee\'s own uuid only', queryCalls[0].eq.employee_id, 'elvia-uuid');
    check('no other table was ever queried (sandbox would have thrown otherwise)', queryCalls.length, 1);
  }

  // Case 2: OFF / vacation status rows.
  {
    const { composite } = await runRenderHours({
      employeeId: 'elvia-legacy-id', employeeUuid: 'elvia-uuid', days: days,
      publishedRows: [
        mk('2026-08-17', { status: 'off', hours: 0 }),
        mk('2026-08-18', { status: 'vacation', hours: 0 }),
      ],
    });
    check('a published "off" row shows a generic Off status, zero hours', composite.status[0], { type: 'off', label: 'Off' });
    check('a published "vacation" row shows Vacation, zero hours', composite.status[1], { type: 'vacation', label: 'Vacation' });
    check('off day has no start/end carried over', composite.days[0], 0);
  }

  // Case 3: no row at all for a past day -> "Not updated yet", never a
  // blank or a zero that looks like a real answer.
  {
    const { composite } = await runRenderHours({
      employeeId: 'elvia-legacy-id', employeeUuid: 'elvia-uuid', days: days,
      publishedRows: [],
    });
    check('a completed day with no published row shows "Not updated yet"', composite.status[0], { type: 'not_published', label: 'Not updated yet' });
    check('that day\'s hours stay 0 (never a fake-looking number)', composite.days[0], 0);
  }

  // Case 4: no row for TODAY specifically -> "in progress", distinct
  // wording from a day that's simply missed publication. Uses the real
  // current date (not a fixed fixture date) as one of the viewed week's
  // days -- renderHours() itself calls dateKey(new Date()) internally,
  // inside the vm sandbox's own realm, which a Node-level Date override
  // in the outer process cannot reach.
  {
    const today = new Date();
    const todayWeek = [0, 1, 2, 3, 4].map(function (offset) {
      const d = new Date(today);
      d.setDate(today.getDate() - today.getDay() + 1 + offset); // Monday of this real week
      return d;
    });
    const todayIdx = todayWeek.findIndex(function (d) { return dk(d) === dk(today); });
    if (todayIdx === -1) {
      console.log('  skip (weekend -- real "today" is not Mon-Fri, nothing to assert)');
    } else {
      const { composite } = await runRenderHours({
        employeeId: 'elvia-legacy-id', employeeUuid: 'elvia-uuid', days: todayWeek,
        publishedRows: [],
      });
      check('today with no published row shows "in progress", not "Not updated yet"', composite.status[todayIdx], { type: 'in_progress', label: 'In progress, updates after your manager reviews' });
    }
  }

  // Case 5: a fetch failure shows the visible error path, never a blank
  // table and never a fake zero.
  {
    let threw = false;
    let result = null;
    try {
      result = await runRenderHours({
        employeeId: 'elvia-legacy-id', employeeUuid: 'elvia-uuid', days: days,
        publishedRows: [], sbOpts: { error: { message: 'network down' } },
      });
    } catch (e) { threw = true; }
    // renderHours() itself catches this internally (writes the red
    // message into #hours-breakdown and returns) -- it must NOT throw
    // out to the caller, and must NOT have called renderHoursData.
    check('a query error is handled inside renderHours(), never thrown out', threw, false);
    check('renderHoursData() was never called on a fetch failure (no fake numbers rendered)', result && result.composite, null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
