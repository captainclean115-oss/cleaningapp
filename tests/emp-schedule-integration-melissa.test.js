// End-to-end integration proof for the Melissa Manna "no schedule tomorrow"
// bug, after THREE fixes (PR #160: renderSchedule's static-team logic,
// PR #161: re-render when the assignments mirror updates, and the
// window.PentaEmployees.getById fix that turned out to be the real root
// cause blocking both). Unlike the other regression tests for this bug
// (which each extract ONE piece and mock its neighbors), this test wires
// the ACTUAL PentaEmployees IIFE + PentaAssignments IIFE +
// _mirrorPentaAssignmentsToInMemory + its hydration-wiring IIFE + the
// global getEmployeeTeam() together, and drives the real async hydration
// sequence (ready().then, onChange callbacks) the way a real browser
// session would -- specifically because the missing-getById bug was an
// INTEGRATION bug between these pieces that no single-piece unit test
// (each of which mocked its neighbors) could have caught.
//
// Fixture: Melissa's real data shape confirmed live via Supabase --
// employees.id 7a8465c8-8ae1-48f8-8657-bfe407f21091, legacy_roster_id
// 'app_796a8946' (job-application-hire flow, non-uuid), team_text/team_id
// both null (no default team), plus a real daily_assignments override row
// for 2026-09-04 team B1.
//
// Run with: node tests/emp-schedule-integration-melissa.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function slice(startMarker, endMarker, fromIdx) {
  const s = src.indexOf(startMarker, fromIdx || 0);
  if (s === -1) { console.error('FAIL: extraction start not found: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: extraction end not found after "' + startMarker + '": ' + endMarker); process.exit(1); }
  return src.slice(s, e + endMarker.length);
}

// 1. PentaEmployees IIFE
const empAnchor = src.indexOf('// window.PentaEmployees — Sprint 4 Phase 4A facade');
const empStart = src.indexOf('(function() {', empAnchor);
const pentaEmployeesEnd = src.indexOf('window.PentaForms = (function() {', empStart);
const pentaEmployeesSrc = src.slice(empStart, src.lastIndexOf('})();', pentaEmployeesEnd) + '})();'.length);

// 2. PentaAssignments IIFE
const pentaAssignmentsSrc = slice('window.PentaAssignments = (function() {', '\n})();\n', empStart + pentaEmployeesSrc.length);

// 3. The mirror function + its render-timer var
const mirrorMarkerStart = 'var _pentaAssignmentsMirrorRenderTimer = null;';
const mirrorMarkerEnd = '\n(function pentaPhase3fMirrorAssignments() {';
const mirrorStartIdx = src.indexOf(mirrorMarkerStart);
if (mirrorStartIdx === -1) { console.error('FAIL: mirror start marker not found'); process.exit(1); }
const mirrorEndIdx = src.indexOf(mirrorMarkerEnd, mirrorStartIdx);
if (mirrorEndIdx === -1) { console.error('FAIL: mirror end marker not found'); process.exit(1); }
const mirrorSrc = src.slice(mirrorStartIdx, mirrorEndIdx);

// 4. The hydration-wiring IIFE that connects PentaAssignments/PentaEmployees onChange to the mirror
const wiringSrc = slice('(function pentaPhase3fMirrorAssignments() {', '\n})();\n', mirrorEndIdx);

// 5. The global getEmployeeTeam() that the employee portal's renderSchedule()
// calls -- NOT the same-named internal helper inside the PentaAssignments
// IIFE (that one's a private closure over PentaAssignments' own _byKey and
// is never exposed globally). The global one is the LAST occurrence of
// this signature in the file.
const getStartMarker = 'function getEmployeeTeam(employeeId, dateStr) {';
const getStartIdx = src.lastIndexOf(getStartMarker);
if (getStartIdx === -1) { console.error('FAIL: global getEmployeeTeam not found'); process.exit(1); }
const getEndIdx = src.indexOf('\n}\n', getStartIdx);
const getEmployeeTeamSrc = src.slice(getStartIdx, getEndIdx + '\n}\n'.length);
if (getEmployeeTeamSrc.indexOf('getUnifiedRoster') === -1) {
  console.error('FAIL: extracted getEmployeeTeam does not reference getUnifiedRoster -- wrong function matched');
  process.exit(1);
}

async function main() {
  const MELISSA = {
    id: '7a8465c8-8ae1-48f8-8657-bfe407f21091',
    legacy_roster_id: 'app_796a8946',
    first_name: 'Melissa', last_name: 'Manna',
    team_text: null, team_id: null,
    business_id: 'biz-manna', status: 'active',
  };
  const ASSIGNMENT_ROW = { date: '2026-09-04', employee_id: MELISSA.id, team: 'B1', status_type: null, notes: null };

  const renderCalls = { teamManager: 0, hoursTable: 0, schedule: 0 };

  const sandbox = {
    console,
    setTimeout, clearTimeout,
    window: {},
    dailyAssignments: {},
    dailyAssignmentDetails: {},
    saveDailyAssignments: function () {},
    renderTeamManager: function () { renderCalls.teamManager++; },
    renderHoursTable: function () { renderCalls.hoursTable++; },
    renderSchedule: function () { renderCalls.schedule++; },
    _refreshCalIfActive: function () {},
    // getEmployeeTeam's fallback path (no override found) -- not expected
    // to be hit on the success path, but stubbed so a regression fails
    // with a clear assertion mismatch instead of a ReferenceError.
    getUnifiedRoster: function () { return []; },
    document: {
      body: { classList: { contains: (c) => c === 'in-portal' } },
      getElementById: function (id) {
        if (id === 'tab-schedule') return { offsetParent: {} }; // schedule tab open
        return null; // hours-table not mounted this session
      },
    },
    supabaseClient: {
      auth: { getUser: () => Promise.resolve({ data: { user: { id: 'melissa-auth-uid' } } }) },
      from: function (table) {
        if (table === 'users') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { business_id: MELISSA.business_id }, error: null }) }) }),
          };
        }
        if (table === 'employees') {
          return {
            select: () => ({ eq: () => ({ is: () => ({ order: () => Promise.resolve({ data: [MELISSA], error: null }) }) }) }),
          };
        }
        if (table === 'daily_assignments') {
          return {
            select: () => ({ eq: () => ({ is: () => ({ order: () => ({ range: () => Promise.resolve({ data: [ASSIGNMENT_ROW], error: null }) }) }) }) }),
          };
        }
        throw new Error('unexpected table ' + table);
      },
    },
  };
  sandbox.window.supabaseClient = sandbox.supabaseClient;

  vm.createContext(sandbox);
  // Order matters: PentaEmployees and PentaAssignments must exist on
  // window before the mirror/wiring code (which references
  // window.PentaEmployees / window.PentaAssignments) runs -- exactly the
  // order index.html itself loads them in.
  vm.runInContext(pentaEmployeesSrc, sandbox);
  vm.runInContext(pentaAssignmentsSrc, sandbox);
  vm.runInContext(mirrorSrc, sandbox);
  vm.runInContext(getEmployeeTeamSrc, sandbox);
  // _setupRealtime isn't relevant here (no real channel infra in this
  // sandbox) -- stub it out so PentaAssignments._hydrate() doesn't throw.
  const origHydrate = sandbox.window.PentaAssignments._hydrate;

  vm.runInContext(wiringSrc, sandbox);

  // Simulate the real boot sequence: currentEmployee resolved from auth
  // (as _bootResolveEmployeeFromAuth would produce for Melissa), then the
  // async hydration chains run exactly as they do in a real page load.
  sandbox.currentEmployee = { id: MELISSA.legacy_roster_id, uuid: MELISSA.id, team: null };

  // Give the ready().then() chains (kicked off by the wiring IIFE) time to
  // resolve, including the ready-then's own microtask hops.
  await sleep(50);
  await sandbox.window.PentaEmployees.ready();
  await sandbox.window.PentaAssignments.ready();
  await sleep(300); // past the mirror's 200ms debounce

  check(
    'dailyAssignments ends up with the legacy_roster_id-keyed entry for tomorrow (what getEmployeeTeam(currentEmployee.id, ...) actually reads)',
    sandbox.dailyAssignments['2026-09-04_app_796a8946'],
    'B1'
  );
  check(
    'getEmployeeTeam(currentEmployee.id, tomorrow) resolves to B1 -- the exact call renderSchedule() makes',
    sandbox.getEmployeeTeam(sandbox.currentEmployee.id, '2026-09-04'),
    'B1'
  );
  check(
    'the employee portal schedule tab was re-rendered at least once after the mirror settled (PR #161 hook)',
    renderCalls.schedule > 0,
    true
  );

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
