// Tom: "Claire seems stuck or limited, I am trying to get her to change
// employees' start and stop times for each day."
//
// Investigated Claire's edit_employee_hours/get_employee_hours tools --
// they DO support setting an explicit start/end TIME for a specific date
// (writes to manual_hour_overrides via PentaHourOverrides.setOverride).
// That capability isn't missing. What IS a real bug: findEmployees()
// (index.html) -- the PR #176 disambiguation matcher these two tools call
// via findEmployeeWithSuggestions -- scored every roster entry whose full
// name merely CONTAINS the query as a substring (tier 700) alongside an
// exact/token match (tier 1000/900), and returned ALL of them sorted by
// score instead of just the winning tier. Since both handlers treat
// `matches.length > 1` as ambiguous_employee, an obviously-exact query
// like "Maria Vieira" got stuck asking Tom to disambiguate against an
// unrelated employee like "Ana Maria Vieira Santos" whose name simply
// happens to contain that substring -- exactly the "feels stuck" symptom,
// on what Tom would consider an unambiguous name.
//
// Fixed by filtering findEmployees()'s results down to only the top score
// tier: a clearly-better match (exact/token) now wins outright over a
// merely-contains match, while a genuine tie (e.g. multiple "Maria
// <something>" employees sharing the literal first-name token) still
// correctly returns multiple candidates -- this codebase has 7+ real
// duplicate-name employee groups (see feedback_name_based_identity_
// resolution_risk), so that disambiguation prompt is still needed and
// still fires.
//
// Run with: node tests/find-employees-substring-false-ambiguity.test.js

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

const cnStart = src.indexOf('function _cleanName');
if (cnStart === -1) { console.error('FAIL: could not find _cleanName'); process.exit(1); }
const cnEnd = src.indexOf('\n}', cnStart) + 2;
const cnSource = src.slice(cnStart, cnEnd);

const feStart = src.indexOf('function findEmployees(query)');
if (feStart === -1) { console.error('FAIL: could not find findEmployees'); process.exit(1); }
const feEnd = src.indexOf('\nfunction findEmployeeWithSuggestions', feStart);
if (feEnd === -1) { console.error('FAIL: could not find end boundary after findEmployees'); process.exit(1); }
const feSource = src.slice(feStart, feEnd);

if (!/var topScore = scored\.length/.test(feSource)) {
  console.error('FAIL: findEmployees does not appear to filter to the top score tier -- fix may have been reverted.');
  process.exit(1);
}

function runFindEmployees(query, roster) {
  const sandbox = { getUnifiedRoster: function() { return roster; } };
  vm.createContext(sandbox);
  vm.runInContext(cnSource + '\n' + feSource, sandbox);
  return sandbox.findEmployees(query).map(function(e) { return e.name; });
}

const roster = [
  { id: 'e1', name: 'Maria Vieira' },
  { id: 'e2', name: 'Ana Maria Vieira Santos' },
  { id: 'e3', name: 'Carlos Silva' },
  { id: 'e4', name: 'Maria Santos' },
  { id: 'e5', name: 'Maria Lopez' }
];

check(
  'an exact full-name match wins outright over an unrelated employee whose name merely contains it as a substring',
  runFindEmployees('Maria Vieira', roster),
  ['Maria Vieira']
);

check(
  'a unique exact match with no substring collisions still resolves to exactly one employee',
  runFindEmployees('Carlos Silva', roster),
  ['Carlos Silva']
);

check(
  'a genuine tie (shared first-name token across several employees) still returns all of them -- real ambiguity is preserved, not suppressed',
  runFindEmployees('Maria', roster).sort(),
  ['Ana Maria Vieira Santos', 'Maria Lopez', 'Maria Santos', 'Maria Vieira'].sort()
);

check(
  'an unknown name still returns no matches (falls through to suggestions, not a false positive)',
  runFindEmployees('Zzyzx Nobody', roster),
  []
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
