// Salaried Admin/Office (follow-up to migration 113, no schema change
// -- reuses the existing employees.pay_type column). Core helper +
// roster passthrough.
//
// pay_type is a Postgres enum (employee_pay_type: 'hourly' | 'salary')
// -- confirmed live via information_schema before writing any of this,
// not guessed. isSalariedAdmin(emp) is the ONE check every hours
// surface in this feature reuses.
//
// Run with: node tests/salaried-admin-core-helper.test.js

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

const isSalariedAdminSrc = extract(
  'function isSalariedAdmin(emp) {',
  '\n\n// ═══════════════════════════════════════════════════════════════════════\n// Sprint 9 Phase A',
  'isSalariedAdmin'
);

// getUnifiedRoster -- leading '\n' required, there's a second, indented
// getEmployeeTeam-shaped collision risk elsewhere in this file for
// other names; this guards the same class of mistake for consistency.
const rosterSrc = extract(
  'function getUnifiedRoster(asOfDate) {',
  '\n\n\n// Daily assignments',
  'getUnifiedRoster'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(isSalariedAdminSrc, sandbox);
  return sandbox;
}

function main() {
  const sandbox = buildSandbox();

  check('admin + salary = true', sandbox.isSalariedAdmin({ work_type: 'admin', pay_type: 'salary' }), true);
  check('admin + hourly = false', sandbox.isSalariedAdmin({ work_type: 'admin', pay_type: 'hourly' }), false);
  check('admin + no pay_type set = false (defaults safe)', sandbox.isSalariedAdmin({ work_type: 'admin', pay_type: null }), false);
  check('field + salary = false (field employees are explicitly out of scope)', sandbox.isSalariedAdmin({ work_type: 'field', pay_type: 'salary' }), false);
  check('field + hourly = false', sandbox.isSalariedAdmin({ work_type: 'field', pay_type: 'hourly' }), false);
  check('null employee = false, never throws', sandbox.isSalariedAdmin(null), false);
  check('undefined employee = false, never throws', sandbox.isSalariedAdmin(undefined), false);
  check('literal "salaried" (not the real enum value "salary") does NOT match -- guards against the wrong string', sandbox.isSalariedAdmin({ work_type: 'admin', pay_type: 'salaried' }), false);

  // ---- getUnifiedRoster carries pay_type through the facade row (same way work_type already does) ----
  {
    const rosterSandbox = { console, EMPLOYEE_ROSTER: [] };
    vm.createContext(rosterSandbox);
    vm.runInContext(rosterSrc, rosterSandbox);
    rosterSandbox.window = {
      PentaEmployees: {
        listSync: () => [
          { id: 'u-linda', legacy_roster_id: 'e1', name: 'Linda', team: null, role: [], status: 'active', work_type: 'admin', pay_type: 'salary' },
          { id: 'u-alice', legacy_roster_id: 'e2', name: 'Alice', team: 'B1', role: [], status: 'active', work_type: 'field', pay_type: null },
        ],
      },
    };
    const roster = rosterSandbox.getUnifiedRoster();
    const linda = roster.find((e) => e.name === 'Linda');
    const alice = roster.find((e) => e.name === 'Alice');
    check('getUnifiedRoster carries pay_type=salary through for Linda', linda && linda.pay_type, 'salary');
    check('getUnifiedRoster carries a null pay_type through as null (not a crash, not a default guess) for Alice', alice && alice.pay_type, null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
