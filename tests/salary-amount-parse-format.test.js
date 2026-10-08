// Salary amount/period (migration 114 follow-up) -- the pure parse/
// format/display helpers (_parseSalaryAmountInput, _fmtSalaryAmountInput,
// _fmtSalaryLine, _staffReformatSalaryAmountInput), extracted and run
// against the REAL code, not a reimplementation. Covers the exact bug
// class that motivated type=text/inputmode=decimal instead of
// type=number: commas, a leading $, negatives, and non-numeric junk.
//
// Run with: node tests/salary-amount-parse-format.test.js

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

const helpersSrc = extract(
  'function _parseSalaryAmountInput(raw) {',
  '\n\n// ═══════════════════════════════════════════════════════════════════════',
  '_parseSalaryAmountInput + _fmtSalaryAmountInput + _fmtSalaryLine + _staffReformatSalaryAmountInput'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox() {
  const alerts = [];
  const els = {};
  function defaultEl() { return { value: '' }; }
  const sandbox = {
    console,
    alert: (msg) => alerts.push(msg),
    document: {
      getElementById: (id) => { if (!els[id]) els[id] = defaultEl(); return els[id]; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(helpersSrc, sandbox);
  return { sandbox, alerts, els };
}

function main() {
  const { sandbox } = buildSandbox();

  // ---- _parseSalaryAmountInput ----
  check('blank input is valid (not-set-yet state)', sandbox._parseSalaryAmountInput(''), { ok: true, value: null });
  check('whitespace-only input is treated as blank', sandbox._parseSalaryAmountInput('   '), { ok: true, value: null });
  check('plain integer parses correctly', sandbox._parseSalaryAmountInput('13000'), { ok: true, value: 13000 });
  check('comma thousands separators are stripped', sandbox._parseSalaryAmountInput('13,000'), { ok: true, value: 13000 });
  check('a leading $ is stripped', sandbox._parseSalaryAmountInput('$13,000'), { ok: true, value: 13000 });
  check('$ and commas together are stripped', sandbox._parseSalaryAmountInput('$13,000.50'), { ok: true, value: 13000.5 });
  check('already-formatted display value round-trips', sandbox._parseSalaryAmountInput('13,000.00'), { ok: true, value: 13000 });
  check('extra decimals round to 2 places', sandbox._parseSalaryAmountInput('13000.456'), { ok: true, value: 13000.46 });
  check('a negative amount is rejected', sandbox._parseSalaryAmountInput('-500').ok, false);
  check('a negative amount error message is visible and specific', sandbox._parseSalaryAmountInput('-500').error, 'Salary amount cannot be negative.');
  check('letters are rejected, not silently parsed as 0', sandbox._parseSalaryAmountInput('thirteen thousand').ok, false);
  check('a stray trailing letter is rejected', sandbox._parseSalaryAmountInput('13000x').ok, false);
  check('a non-numeric error message is visible', /must be a number/.test(sandbox._parseSalaryAmountInput('abc').error), true);

  // ---- _fmtSalaryAmountInput ----
  check('whole-dollar amount formats with .00', sandbox._fmtSalaryAmountInput(13000), '13,000.00');
  check('fractional amount formats with 2 decimals', sandbox._fmtSalaryAmountInput(13000.5), '13,000.50');
  check('null formats to empty string', sandbox._fmtSalaryAmountInput(null), '');

  // ---- _fmtSalaryLine ----
  check('a fully-set salaried employee shows amount + period', sandbox._fmtSalaryLine({ salary_amount: 13000, salary_period: 'month' }), 'Salaried - $13,000/month');
  check('a fractional amount keeps its cents in the summary line', sandbox._fmtSalaryLine({ salary_amount: 13000.5, salary_period: 'year' }), 'Salaried - $13,000.50/year');
  check('week period formats correctly', sandbox._fmtSalaryLine({ salary_amount: 500, salary_period: 'week' }), 'Salaried - $500/week');
  check('missing amount falls back to plain "Salaried" (not-set-yet state)', sandbox._fmtSalaryLine({ salary_amount: null, salary_period: 'month' }), 'Salaried');
  check('missing period falls back to plain "Salaried"', sandbox._fmtSalaryLine({ salary_amount: 13000, salary_period: null }), 'Salaried');
  check('both missing falls back to plain "Salaried"', sandbox._fmtSalaryLine({ salary_amount: null, salary_period: null }), 'Salaried');
  check('no employee object at all is handled without throwing', sandbox._fmtSalaryLine(null), 'Salaried');

  // ---- _staffReformatSalaryAmountInput (onblur handler) ----
  {
    const { sandbox: sb2, alerts, els } = buildSandbox();
    els['staff-salary-amount'] = { value: '$13,000' };
    sb2._staffReformatSalaryAmountInput();
    check('onblur reformats a valid typed value to the display form', els['staff-salary-amount'].value, '13,000.00');
    check('no alert fires for valid input', alerts.length, 0);
  }
  {
    const { sandbox: sb3, alerts, els } = buildSandbox();
    els['staff-salary-amount'] = { value: 'not a number' };
    sb3._staffReformatSalaryAmountInput();
    check('onblur leaves invalid input exactly as typed (so Tom can see and fix his own mistake)', els['staff-salary-amount'].value, 'not a number');
    check('onblur shows a visible alert for invalid input, never a silent failure', alerts.length, 1);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
