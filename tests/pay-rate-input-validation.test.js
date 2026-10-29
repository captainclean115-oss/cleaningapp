// Pay rate input hardening -- extracts and runs the ACTUAL
// _parsePayRateInput() from index.html. Covers the full rule set: text
// input (immune to scroll-wheel/arrow-key drift, verified separately by
// confirming the HTML is type="text" not type="number"), $ and comma
// stripping, rounding to 2 decimals, rejecting negative/non-numeric
// values with a visible message, and treating blank as "no rate" (null),
// never 0.
//
// Run with: node tests/pay-rate-input-validation.test.js

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

const fnSrc = extract(
  'function _parsePayRateInput(raw) {',
  '\n\nasync function saveMainEmp() {',
  '_parsePayRateInput'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox() {
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox;
}

(function () {
  console.log('Testing extracted _parsePayRateInput() from index.html\n');
  const parse = buildSandbox()._parsePayRateInput;

  check('plain number', parse('22.5'), { ok: true, value: 22.5 });
  check('dollar sign stripped', parse('$22.50'), { ok: true, value: 22.5 });
  check('commas stripped (e.g. a large typo-prone value)', parse('$1,200.50'), { ok: true, value: 1200.5 });
  check('rounds to 2 decimals', parse('22.567'), { ok: true, value: 22.57 });
  check('blank input means "no rate set" (null, never 0)', parse(''), { ok: true, value: null });
  check('whitespace-only input also means "no rate set"', parse('   '), { ok: true, value: null });
  check('negative value rejected with a visible message, nothing saved implied', parse('-5').ok, false);
  check('non-numeric garbage rejected', parse('abc').ok, false);
  check('a rejected value never silently becomes 0 or NaN', parse('abc').value, undefined);
  check('every rejection includes a visible, non-empty message', parse('abc').message.length > 0, true);
  check('a bare "0" is a valid, deliberate entry (distinct from blank)', parse('0'), { ok: true, value: 0 });
  check('trailing/leading whitespace around a real number is tolerated', parse('  22.50  '), { ok: true, value: 22.5 });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
