// PR #134/#137 scenarios, re-targeted at the portal-hours-match-manager
// fix: renderHours() no longer reads a stale, device-local localStorage
// snapshot -- it calls loadWeekHours() (mocked here, since the real one
// does a live Supabase/Geotab round-trip) to populate the SAME
// weekHours/window._empHoursMap globals renderHoursTable itself reads,
// then resolves each day through the SAME shared resolveEmployeeDayHours()
// function the manager's Hours table cells use. Extracts and runs the
// ACTUAL renderHours() + resolveEmployeeDayHours() + getEmployeeTeam()
// source from index.html, not a reimplementation.
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

const resolveSrc = extract(
  'function resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData) {',
  '\n\nfunction renderHoursTable(days, dayNames) {',
  'resolveEmployeeDayHours'
);
const getEmployeeTeamSrc = extract('\nfunction getEmployeeTeam(employeeId, dateStr) {', '\nfunction getTeamEmployees(', 'getEmployeeTeam');
const renderHoursSrc = extract('\nasync function renderHours() {', '\nfunction getPortalWeekDates(', 'renderHours');
// PR #137 -- real source for the OFF-status helpers renderHours() calls.
const dayOffSrc = extract(
  '\nconst DAY_OFF_CATEGORY_LABELS = {',
  '\n// ═══════════════════════════════════════════════════════════════════════\n// Sprint 9 Phase A',
  'day-off helpers'
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

// Runs the real renderHours() against a mocked loadWeekHours() (the
// live Supabase/Geotab fetch itself is out of scope for this file --
// see hours-report-range-computation.test.js / loadweekhours-*.test.js
// for that) and returns whatever composite object it handed to
// renderHoursData (spied, not executed), plus whatever hoursWeekOffset
// was set to at the moment loadWeekHours() was actually called.
async function runRenderHours(opts) {
  let capturedComposite = null;
  let hoursWeekOffsetAtLoadCall = undefined;
  const days = opts.days; // array of 5 real Date objects, Mon-Fri
  const dk = function (d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  };

  const sandbox = {
    console: console,
    document: makeDocStub(),
    window: { _empHoursMap: {} },
    dailyAssignments: opts.dailyAssignments,
    dailyAssignmentDetails: opts.dailyAssignmentDetails || {},
    getUnifiedRoster: function () { return [{ id: opts.employeeId, defaultTeam: opts.defaultTeam }]; },
    getEmployeeTeam: null, // filled in below after compiling
    getEmployeeDayOffInfo: null, // filled in below after compiling
    getEmpHours: function () { return opts.override || null; }, // manual_hour_overrides -- null unless a case opts one in
    _hrsFmt12: function (x) { return x == null ? '' : String(x); }, // display formatting is out of scope here
    currentEmployee: { id: opts.employeeId, team: opts.defaultTeam, team_text: opts.defaultTeam, team_id: null },
    currentLang: 'en',
    _portalWeekOffset: 0,
    hoursWeekOffset: opts.staleManagerOffset != null ? opts.staleManagerOffset : -3, // simulates a manager's own unrelated week left loaded
    weekHours: {}, // populated by the loadWeekHours mock below, matching the real global
    t: function (k) { return k; },
    dateKey: dk,
    getPortalWeekDates: function () { return days; },
    renderHoursData: function (composite) { capturedComposite = composite; },
    // Mocked: the real loadWeekHours() does a live Supabase/Geotab
    // round-trip -- this simulates "a live fetch just completed" by
    // populating the SAME two globals (weekHours, window._empHoursMap)
    // the real one does, keyed by whatever hoursWeekOffset renderHours()
    // set it to just before calling this -- proving the alignment itself
    // works, not just that SOME data shows up.
    loadWeekHours: function () {
      hoursWeekOffsetAtLoadCall = sandbox.hoursWeekOffset;
      sandbox.weekHours = opts.weekHoursData || {};
      sandbox.window._empHoursMap = opts.empHoursMapData || {};
      return Promise.resolve();
    },
  };
  sandbox.window.PentaAssignments = { ready: function () { return Promise.resolve(); } };
  sandbox.window.PentaEmployees = { ready: function () { return Promise.resolve(); } };
  sandbox.window.PentaTeams = undefined;
  sandbox._mirrorPentaAssignmentsToInMemory = function () {}; // dailyAssignments seeded directly, no real mirror needed

  vm.createContext(sandbox);
  vm.runInContext(dayOffSrc, sandbox);
  vm.runInContext(getEmployeeTeamSrc, sandbox);
  vm.runInContext(resolveSrc, sandbox);
  vm.runInContext(renderHoursSrc, sandbox);
  await vm.runInContext('renderHours()', sandbox);
  return { composite: capturedComposite, hoursWeekOffsetAtLoadCall: hoursWeekOffsetAtLoadCall, hoursWeekOffsetAfter: sandbox.hoursWeekOffset };
}

function dateToStr(iso) { return new Date(iso); }

(async function () {
  console.log('Testing extracted renderHours() from index.html\n');

  // Fixed Mon-Fri so dateKey() output is deterministic across machines.
  const days = [
    new Date(2026, 7, 17), // Mon Aug 17
    new Date(2026, 7, 18), // Tue Aug 18 -- the override day
    new Date(2026, 7, 19),
    new Date(2026, 7, 20),
    new Date(2026, 7, 21),
  ];

  const weekHoursData = {
    B1: { days: [8, 8, 8, 8, 8], starts: [dateToStr('2026-08-17T13:12:00.000Z'), dateToStr('2026-08-18T13:12:00.000Z'), null, null, null], ends: [dateToStr('2026-08-17T21:46:00.000Z'), dateToStr('2026-08-18T14:46:00.000Z'), null, null, null], lunch: [null, null, null, null, null], total: 40, source: 'geotab' },
    B5: { days: [0, 6, 0, 0, 0], starts: [null, dateToStr('2026-08-18T12:59:00.000Z'), null, null, null], ends: [null, dateToStr('2026-08-18T18:49:00.000Z'), null, null, null], lunch: [null, null, null, null, null], total: 6, source: 'geotab' },
  };

  // Case 1 (THE Elvia scenario): default team B1, but an active
  // daily_assignments-style override to B5 on Aug 18 -- the portal must
  // show B5's numbers for that one day, B1's for the rest -- exactly
  // what the manager's Hours table itself would show for the same
  // employee/day (same resolveEmployeeDayHours call, same precedence).
  {
    const { composite, hoursWeekOffsetAtLoadCall, hoursWeekOffsetAfter } = await runRenderHours({
      employeeId: 'elvia-legacy-id',
      defaultTeam: 'B1',
      dailyAssignments: { ['2026-08-18_elvia-legacy-id']: 'B5' },
      weekHoursData: weekHoursData,
      days: days,
      staleManagerOffset: -3,
    });
    check('Aug 18 (override day) hours come from B5, not the default B1', composite.days[1], 6);
    check('Aug 18 start time comes from B5\'s live data', composite.starts[1], '2026-08-18T12:59:00.000Z');
    check('Aug 17 (no override) hours still come from default team B1', composite.days[0], 8);
    check('hoursWeekOffset was aligned to the portal\'s own week (0) at the moment loadWeekHours() ran', hoursWeekOffsetAtLoadCall, 0);
    check('hoursWeekOffset is restored afterward, so a concurrent manager session is unaffected', hoursWeekOffsetAfter, -3);
  }

  // Case 2: no override at all -- every day should fall through to the
  // default team's numbers (nothing should regress for employees
  // without overrides).
  {
    const { composite } = await runRenderHours({
      employeeId: 'elvia-legacy-id',
      defaultTeam: 'B1',
      dailyAssignments: {},
      weekHoursData: weekHoursData,
      days: days,
    });
    check('no override anywhere -> every day uses the default team', composite.days, [8, 8, 8, 8, 8]);
  }

  // Case 3 (PR #137 -- THE Blanca scenario): an explicit OFF day must
  // show zero hours and an off status, NOT the default team's GPS hours.
  {
    const daysB = [
      new Date(2026, 7, 10), // Mon Aug 10 -- the OFF day
      new Date(2026, 7, 11),
      new Date(2026, 7, 12),
      new Date(2026, 7, 13),
      new Date(2026, 7, 14),
    ];
    const weekHoursDataB = {
      B3: { days: [8, 8, 8, 8, 8], starts: [dateToStr('2026-08-10T13:00:00.000Z'), null, null, null, null], ends: [dateToStr('2026-08-10T21:00:00.000Z'), null, null, null, null], lunch: [null, null, null, null, null], total: 40, source: 'geotab' },
    };
    const { composite } = await runRenderHours({
      employeeId: 'blanca-legacy-id',
      defaultTeam: 'B3',
      dailyAssignments: { ['2026-08-10_blanca-legacy-id']: 'OFF' },
      dailyAssignmentDetails: { ['2026-08-10_blanca-legacy-id']: { status_type: 'vacation', notes: null } },
      weekHoursData: weekHoursDataB,
      days: daysB,
    });
    check('OFF day shows zero hours, not the default team\'s GPS hours', composite.days[0], 0);
    check('OFF day has no start time carried over from the default team', composite.starts[0], null);
    check('OFF day status is captured with its real category', composite.status[0], { type: 'vacation', label: 'Vacation' });
    check('non-OFF days in the same week are unaffected', composite.days[1], 8);
  }

  // Case 4: OFF with no status_type on the row at all must still show
  // a generic "Off" status, not silently fall through.
  {
    const daysB = [
      new Date(2026, 7, 10),
      new Date(2026, 7, 11),
      new Date(2026, 7, 12),
      new Date(2026, 7, 13),
      new Date(2026, 7, 14),
    ];
    const weekHoursDataB = {
      B3: { days: [8, 8, 8, 8, 8], starts: [dateToStr('2026-08-10T13:00:00.000Z'), null, null, null, null], ends: [dateToStr('2026-08-10T21:00:00.000Z'), null, null, null, null], lunch: [null, null, null, null, null], total: 40, source: 'geotab' },
    };
    const { composite } = await runRenderHours({
      employeeId: 'blanca-legacy-id',
      defaultTeam: 'B3',
      dailyAssignments: { ['2026-08-10_blanca-legacy-id']: 'OFF' },
      dailyAssignmentDetails: {},
      weekHoursData: weekHoursDataB,
      days: daysB,
    });
    check('OFF with no category still shows a generic Off status, not the default team\'s hours', composite.status[0], { type: 'off', label: 'Off' });
    check('OFF with no category still shows zero hours', composite.days[0], 0);
  }

  // Case 5 (the actual bug this PR fixes): a manual override wins over
  // the live GPS/clock data, exactly like the manager's Hours table.
  {
    const { composite } = await runRenderHours({
      employeeId: 'elvia-legacy-id',
      defaultTeam: 'B1',
      dailyAssignments: {},
      weekHoursData: weekHoursData,
      override: { hours: 7.5, start: '09:00', end: '16:30', lunch: 30 },
      days: days,
    });
    check('a manual override wins over the live GPS/clock data for every day', composite.days, [7.5, 7.5, 7.5, 7.5, 7.5]);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
