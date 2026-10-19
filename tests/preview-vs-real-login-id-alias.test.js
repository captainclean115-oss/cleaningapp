// Portal-hours-match-manager fix -- REAL, CONFIRMED bug: a real
// employee login (_bootResolveEmployeeFromAuth) aliases
// emp.id = legacy_roster_id || uuid before calling appUnlockEmployee.
// Several "Preview as employee" entry points instead pass a raw
// facade row (getStaffList()/PentaEmployees.listSync(), via _fromRow)
// whose .id is the Supabase uuid, NOT aliased. Every hours-reading
// function in this file (getEmpHours, getEmployeeTeam, dailyAssignments)
// keys by legacy_roster_id when one exists -- confirmed live, ALL 25
// currently-active employees have one that differs from their uuid.
// This test proves appUnlockEmployee now normalizes BOTH shapes to the
// same identity before anything else reads currentEmployee.id.
//
// Run with: node tests/preview-vs-real-login-id-alias.test.js

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
  return src.slice(s, e);
}

const fnSrc = extract(
  'function appUnlockEmployee(emp) {',
  '\n\n// ═══════════════════════════════════════════════════════════════════════\n// VIEW AS EMPLOYEE',
  'appUnlockEmployee'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox() {
  const els = {};
  function el(id) { if (!els[id]) els[id] = { style: {}, classList: { add() {}, remove() {}, contains: () => false }, textContent: '' }; return els[id]; }
  const sandbox = {
    console,
    document: {
      documentElement: { classList: { add() {}, remove() {} } },
      body: { classList: { add() {}, remove() {} } },
      getElementById: (id) => el(id),
      querySelector: () => ({ style: {} }),
    },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    localStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    submittedForms: null,
    renderPortalSubmittedForms: () => {},
    renderPortalFormCards: () => {},
    renderPortalCustomFormCards: () => {},
    setTimeout: (fn) => fn(),
    appSelectedLang: 'en',
    currentLang: null,
    currentEmployee: null,
    window: { PentaTeams: { getById: () => null } },
    isSalariedAdmin: () => false,
    updatePortalText: () => {},
    renderSchedule: () => {},
    renderHours: () => {},
    renderHandbook: () => {},
    checkExistingSignature: () => {},
    updateFormLabels: () => {},
    showPortalTab: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox;
}

function main() {
  // ---- Preview-style raw facade row: .id is the Supabase uuid, legacy_roster_id is separate ----
  {
    const sandbox = buildSandbox();
    const facadeRow = { id: 'uuid-1234', legacy_roster_id: 'e-47', name: 'Elvia Tonato', team: 'B1', team_id: null, work_type: 'field' };
    sandbox.appUnlockEmployee(facadeRow);
    check('currentEmployee.id is normalized to legacy_roster_id (the key every hours function actually reads)', sandbox.currentEmployee.id, 'e-47');
    check('currentEmployee.uuid preserves the original Supabase id (for anything that needs the real uuid)', sandbox.currentEmployee.uuid, 'uuid-1234');
  }

  // ---- Real-login-style, already-aliased row: no-op, nothing changes ----
  {
    const sandbox = buildSandbox();
    const bootRow = { id: 'e-47', uuid: 'uuid-1234', legacy_roster_id: 'e-47', name: 'Elvia Tonato', team: 'B1', work_type: 'field' };
    sandbox.appUnlockEmployee(bootRow);
    check('an already-aliased row (real login shape) is left exactly as-is', sandbox.currentEmployee.id, 'e-47');
    check('uuid is still correct and untouched', sandbox.currentEmployee.uuid, 'uuid-1234');
  }

  // ---- No legacy_roster_id at all (a facade-only employee, never imported from the legacy system): id stays the uuid, unchanged ----
  {
    const sandbox = buildSandbox();
    const facadeRowNoLegacy = { id: 'uuid-5678', legacy_roster_id: null, name: 'New Hire', team: 'B1', work_type: 'field' };
    sandbox.appUnlockEmployee(facadeRowNoLegacy);
    check('no legacy_roster_id means nothing to alias -- id stays the uuid', sandbox.currentEmployee.id, 'uuid-5678');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
