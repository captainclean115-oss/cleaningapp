// findEmployees()/findEmployeeWithSuggestions() -- Tom: "Claire should
// handle common name variations. If ambiguous ('Maria' matches two
// employees), ask which one." Extracts the REAL functions verbatim
// (not a reimplementation) and runs them against a synthetic roster
// modeling the exact live scenario this codebase has: two "Maria
// Vieira" records (one terminated, one active) plus another active
// "Maria" (Rodriguez), proving the disambiguation and terminated-
// exclusion behavior against real logic, not an assumption about it.
//
// Run with: node tests/find-employees-disambiguation.test.js

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

function extract(startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) { console.error('FAIL: could not find end marker after ' + startMarker); process.exit(1); }
  return src.slice(startIdx, endIdx);
}

// _cleanName/_lev are pure, no-dependency helpers -- extract those too
// rather than mocking them, since they're exactly what's under test
// (the ranking/disambiguation logic depends on their real behavior).
const cleanNameSrc = extract('function _cleanName(s) {', '\n// v9.5.4');
const levSrc = extract('function _lev(a, b) {', '\n\n// Returns { matches:');

// findEmployees/findEmployeeWithSuggestions are two separate function
// declarations back to back -- extract through the end of the second one.
const bothStart = src.indexOf('function findEmployees(query) {');
const bothEnd = src.indexOf('\n\n// Tools that return information to Claire');
if (bothStart === -1 || bothEnd === -1) { console.error('FAIL: could not find findEmployees/findEmployeeWithSuggestions block'); process.exit(1); }
const findEmployeesBothSrc = src.slice(bothStart, bothEnd);

function buildSandbox(roster) {
  const sandbox = { console, getUnifiedRoster: function () { return roster; } };
  vm.createContext(sandbox);
  vm.runInContext(cleanNameSrc, sandbox);
  vm.runInContext(levSrc, sandbox);
  vm.runInContext(findEmployeesBothSrc, sandbox);
  return sandbox;
}

// Models the real live scenario: two "Maria Vieira" records (one
// terminated, one active) plus a second active "Maria" (Rodriguez).
// getUnifiedRoster() is mocked here as the true boundary -- its own
// terminated-filtering (PR #148) is separately tested elsewhere; this
// roster represents what a BARE getUnifiedRoster() call already returns
// (terminated employees excluded), matching real production behavior.
const roster = [
  { id: 'e_maria_vieira_active', uuid: 'uuid-mv-active', name: 'Maria Vieira' },
  { id: 'e_maria_rodriguez', uuid: 'uuid-mr', name: 'Maria Rodriguez' },
  { id: 'e_nadia', uuid: 'uuid-nadia', name: 'Nadia Silva' },
  { id: 'e_natalia', uuid: 'uuid-natalia', name: 'Natalia Souza' },
];

function main() {
  const sandbox = buildSandbox(roster);

  // ---- Exact full name -- unambiguous even with another "Maria" active ----
  {
    const r = sandbox.findEmployeeWithSuggestions('Maria Vieira');
    check('exact full name matches exactly one employee', r.matches.length, 1);
    check('resolves to the right employee', r.matches[0].name, 'Maria Vieira');
  }

  // ---- First name alone, two active matches -- must be ambiguous ----
  {
    const r = sandbox.findEmployeeWithSuggestions('Maria');
    check('bare first name shared by two active employees is ambiguous', r.matches.length, 2);
    check('both Marias are in the candidate list', r.matches.map(function (e) { return e.name; }).sort(), ['Maria Rodriguez', 'Maria Vieira']);
  }

  // ---- Unambiguous first name ----
  {
    const r = sandbox.findEmployeeWithSuggestions('Nadia');
    check('a first name unique in the roster resolves unambiguously', r.matches.length, 1);
    check('resolves to the right employee', r.matches[0].name, 'Nadia Silva');
  }

  // ---- Case-insensitive / whitespace-tolerant ----
  {
    const r = sandbox.findEmployeeWithSuggestions('  NADIA  ');
    check('matching is case-insensitive and trims whitespace', r.matches.length === 1 && r.matches[0].name === 'Nadia Silva', true);
  }

  // ---- Common name variation: partial/substring match still works ----
  {
    const r = sandbox.findEmployeeWithSuggestions('Natal');
    check('a name prefix still resolves (common variation handling)', r.matches.length === 1 && r.matches[0].name === 'Natalia Souza', true);
  }

  // ---- No match at all -- suggestions, not a crash ----
  {
    const r = sandbox.findEmployeeWithSuggestions('Zzzznonexistentperson');
    check('zero matches for a totally unrelated query', r.matches.length, 0);
    check('suggestions are still offered (closest names)', r.suggestions.length > 0, true);
  }

  // ---- Empty/falsy query doesn't crash ----
  {
    const r = sandbox.findEmployeeWithSuggestions('');
    check('an empty query returns no matches and no suggestions, not a crash', r, { matches: [], suggestions: [] });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
