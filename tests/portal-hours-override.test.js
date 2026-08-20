// PR #134 — regression test: an employee's own portal must show the
// override team for a specific date, not their static default team.
// Extracts and runs the ACTUAL renderHours() + getEmployeeTeam() source
// from index.html (not a reimplementation — see team-cell-override.test.js
// for why that matters) against a mocked DOM/localStorage/PentaAssignments
// boundary. renderHoursData (the actual DOM-writing tail of the pipeline)
// is stubbed as a spy so this asserts on the composite object renderHours
// builds, not on rendered HTML strings.
//
// Run with: node tests/portal-hours-override.test.js
// No dependencies beyond Node's built-ins (fs, vm).

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error('extraction failed: could not find start marker: ' + startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('extraction failed: could not find end marker after start: ' + endMarker);
  return src.slice(startIdx, endIdx);
}

const getEmployeeTeamSrc = extract('\nfunction getEmployeeTeam(employeeId, dateStr) {', '\nfunction getTeamEmployees(');
const renderHoursSrc = extract('\nasync function renderHours() {', '\nfunction getPortalWeekDates(');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// Minimal DOM stub -- renderHours writes text/style to several header
// elements before reaching the logic under test. A shared object per id
// so repeated getElementById calls for the same id see the same node.
function makeDocStub() {
  const nodes = {};
  return {
    getElementById: function (id) {
      if (!nodes[id]) nodes[id] = { textContent: '', innerHTML: '', style: {} };
      return nodes[id];
    },
  };
}

function makeLocalStorageStub(initial) {
  const store = Object.assign({}, initial);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
  };
}

// Runs the real renderHours() against a given weekHours_cache blob and
// dailyAssignments state, for a given employee, and returns whatever
// composite object it handed to renderHoursData (spied, not executed).
async function runRenderHours(opts) {
  let capturedComposite = null;
  const days = opts.days; // array of 5 real Date objects, Mon-Fri
  const dk = function (d) {
    // Same shape as the real app's dateKey: YYYY-MM-DD, LOCAL not UTC.
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  };

  const sandbox = {
    console: console,
    document: makeDocStub(),
    window: {},
    dailyAssignments: opts.dailyAssignments,
    getUnifiedRoster: function () { return [{ id: opts.employeeId, defaultTeam: opts.defaultTeam }]; },
    getEmployeeTeam: null, // filled in below after compiling
    currentEmployee: { id: opts.employeeId, team: opts.defaultTeam, team_text: opts.defaultTeam, team_id: null },
    currentLang: 'en',
    _portalWeekOffset: 0,
    t: function (k) { return k; },
    dateKey: dk,
    getPortalWeekDates: function () { return days; },
    localStorage: makeLocalStorageStub(opts.localStorage || {}),
    renderHoursData: function (composite) { capturedComposite = composite; },
  };
  sandbox.window.PentaAssignments = { ready: function () { return Promise.resolve(); } };
  sandbox.window.PentaEmployees = { ready: function () { return Promise.resolve(); } };
  sandbox.window.PentaTeams = undefined;
  sandbox._mirrorPentaAssignmentsToInMemory = function () {}; // dailyAssignments seeded directly, no real mirror needed

  vm.createContext(sandbox);
  vm.runInContext(getEmployeeTeamSrc, sandbox);
  vm.runInContext(renderHoursSrc, sandbox);
  await vm.runInContext('renderHours()', sandbox);
  return capturedComposite;
}

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
  const dkAug18 = '2026-08-18';

  const weekHoursCache = {
    B1: { days: [8, 8, 8, 8, 8], starts: ['2026-08-17T13:12:00.000Z', '2026-08-18T13:12:00.000Z', null, null, null], ends: ['2026-08-17T21:46:00.000Z', '2026-08-18T14:46:00.000Z', null, null, null], lunch: [null, null, null, null, null], total: 40 },
    B5: { days: [0, 6, 0, 0, 0], starts: [null, '2026-08-18T12:59:00.000Z', null, null, null], ends: [null, '2026-08-18T18:49:00.000Z', null, null, null], lunch: [null, null, null, null, null], total: 6 },
  };

  // Case 1 (THE Elvia scenario): default team B1, but an active
  // daily_assignments-style override to B5 on Aug 18 -- the portal must
  // show B5's numbers for that one day, B1's for the rest.
  const composite1 = await runRenderHours({
    employeeId: 'elvia-legacy-id',
    defaultTeam: 'B1',
    dailyAssignments: { ['2026-08-18_elvia-legacy-id']: 'B5' },
    localStorage: { weekHours_cache: JSON.stringify(weekHoursCache) },
    days: days,
  });
  check('Aug 18 (override day) hours come from B5, not the default B1', composite1.days[1], 6);
  check('Aug 18 start time comes from B5\'s blob', composite1.starts[1], '2026-08-18T12:59:00.000Z');
  check('Aug 17 (no override) hours still come from default team B1', composite1.days[0], 8);

  // Case 2: no override at all -- every day should fall through to the
  // default team's numbers, matching pre-PR-#134 behavior for the
  // common case (nothing should regress for employees without overrides).
  const composite2 = await runRenderHours({
    employeeId: 'elvia-legacy-id',
    defaultTeam: 'B1',
    dailyAssignments: {},
    localStorage: { weekHours_cache: JSON.stringify(weekHoursCache) },
    days: days,
  });
  check('no override anywhere -> every day uses the default team', composite2.days, [8, 8, 8, 8, 8]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
