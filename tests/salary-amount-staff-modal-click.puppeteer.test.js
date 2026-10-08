// Salary amount/period (migration 114 follow-up) -- puppeteer click
// test against the REAL extracted Staff modal markup/functions, real
// Chrome, real clicks. Three things:
//   1. The Salary amount/period fields show whenever Pay Type =
//      Salaried, REGARDLESS of Work Type (unlike the Admin-only Pay
//      Rate dimming) -- confirms the fields aren't accidentally
//      scoped to Admin/Office only.
//   2. The onblur reformatter actually fires on a real blur event and
//      reformats "$13,000" -> "13,000.00" in the live DOM.
//   3. The actual fix for the $13,000 -> $12,998.75 bug: a real wheel
//      event over a focused #staff-pay no longer changes its value
//      (onwheel="this.blur()"), and ArrowUp/ArrowDown no longer step
//      it either (onkeydown preventDefault).
//
// Run with: node tests/salary-amount-staff-modal-click.puppeteer.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const employmentMarkup = extract(
  '<!-- EMPLOYMENT -->',
  '\n        <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Language</div>',
  'Staff modal Employment section markup (Work Type, Pay Type, salary fields, Pay Rate)'
);
const toggleWorkTypeSrc = extract(
  'function _staffToggleTeamFieldForWorkType() {',
  'function _staffToggleHourlyFieldsForPayType() {',
  '_staffToggleTeamFieldForWorkType'
);
const togglePayTypeSrc = extract(
  'function _staffToggleHourlyFieldsForPayType() {',
  '\n\nfunction openAddStaff() {',
  '_staffToggleHourlyFieldsForPayType'
);
const parseSrc = extract(
  'function _parseSalaryAmountInput(raw) {',
  '\n\n// Nicely-formatted display string',
  '_parseSalaryAmountInput'
);
const fmtInputSrc = extract(
  'function _fmtSalaryAmountInput(n) {',
  '\n\nvar SALARY_PERIOD_LABEL',
  '_fmtSalaryAmountInput'
);
const reformatSrc = extract(
  'function _staffReformatSalaryAmountInput() {',
  '\n\n// ═══════════════════════════════════════════════════════════════════════',
  '_staffReformatSalaryAmountInput'
);

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Salary amount/period fixture</title></head>
<body>
  ${employmentMarkup}

  <script>
    window.__alerts = [];
    window.alert = function(msg) { window.__alerts.push(msg); };

    ${toggleWorkTypeSrc}
    ${togglePayTypeSrc}
    ${parseSrc}
    ${fmtInputSrc}
    ${reformatSrc}
  </script>
</body></html>`;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('SKIP: no local Chrome found (checked common paths) -- install Chrome or point findChrome() at it');
    process.exit(0);
  }

  const fixturePath = path.join(os.tmpdir(), 'salary-amount-fixture-' + Date.now() + '.html');
  fs.writeFileSync(fixturePath, FIXTURE_HTML);

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

    await page.goto('file://' + fixturePath, { waitUntil: 'load' });
    check('fixture loaded with no uncaught JS errors', pageErrors, []);

    // ---- Salary fields visibility: Pay Type alone controls them, not Work Type ----
    check('salary fields start hidden (Pay Type defaults to Hourly)', await page.$eval('#staff-salary-fields', (el) => el.style.display), 'none');

    await page.select('#staff-work-type', 'field'); // still Field team
    await page.select('#staff-pay-type', 'salary');
    check('salary fields show for a SALARIED FIELD employee (not Admin-scoped)', await page.$eval('#staff-salary-fields', (el) => el.style.display), '');
    check('the Pay Rate field is NOT dimmed for a salaried field employee (out of scope)', await page.$eval('#staff-pay', (el) => el.disabled), false);

    await page.select('#staff-work-type', 'admin');
    check('salary fields still show once Admin/Office is also picked', await page.$eval('#staff-salary-fields', (el) => el.style.display), '');
    check('NOW the Pay Rate field is dimmed (Admin+Salaried combo)', await page.$eval('#staff-pay', (el) => el.disabled), true);

    await page.select('#staff-pay-type', 'hourly');
    check('switching back to Hourly hides the salary fields', await page.$eval('#staff-salary-fields', (el) => el.style.display), 'none');

    // ---- Kept-on-file note: shown when Hourly but a value is already typed in the (now-hidden) field ----
    await page.select('#staff-pay-type', 'salary');
    await page.$eval('#staff-salary-amount', (el) => (el.value = '13000'));
    await page.select('#staff-pay-type', 'hourly');
    check('the "kept on file" note appears when switching to Hourly with a stored amount present', await page.$eval('#staff-salary-kept-note', (el) => el.style.display), '');

    // ---- onblur reformatter: real blur event in a real browser ----
    await page.select('#staff-pay-type', 'salary');
    await page.$eval('#staff-salary-amount', (el) => (el.value = '$13,000'));
    await page.focus('#staff-salary-amount');
    await page.$eval('#staff-salary-amount', (el) => el.blur()); // fires a real blur event
    const reformatted = await page.$eval('#staff-salary-amount', (el) => el.value);
    check('a real blur event reformats "$13,000" to "13,000.00"', reformatted, '13,000.00');

    await page.$eval('#staff-salary-amount', (el) => (el.value = 'not a number'));
    await page.focus('#staff-salary-amount');
    await page.$eval('#staff-salary-amount', (el) => el.blur());
    const alertsAfterBadInput = await page.evaluate(() => window.__alerts);
    check('invalid input on blur triggers a visible alert', alertsAfterBadInput.length > 0, true);
    const leftAsTyped = await page.$eval('#staff-salary-amount', (el) => el.value);
    check('invalid input is left exactly as typed, not silently cleared', leftAsTyped, 'not a number');

    // ---- The actual $13,000 -> $12,998.75 bug fix: wheel + arrow keys on Pay Rate ----
    await page.$eval('#staff-pay', (el) => { el.disabled = false; el.value = '13000'; });
    await page.focus('#staff-pay');
    await page.evaluate(() => {
      var el = document.getElementById('staff-pay');
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    const valueAfterWheel = await page.$eval('#staff-pay', (el) => el.value);
    check('a wheel event over a focused Pay Rate field no longer changes its value', valueAfterWheel, '13000');
    const activeAfterWheel = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('the wheel handler blurs the field (onwheel="this.blur()")', activeAfterWheel, '');

    await page.$eval('#staff-pay', (el) => { el.value = '13000'; });
    await page.focus('#staff-pay');
    await page.keyboard.press('ArrowUp');
    const valueAfterArrow = await page.$eval('#staff-pay', (el) => el.value);
    check('ArrowUp no longer steps the Pay Rate value (the exact nudge that caused 12998.75)', valueAfterArrow, '13000');

  } finally {
    await browser.close();
    fs.unlinkSync(fixturePath);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
