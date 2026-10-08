// Salaried Admin/Office (follow-up to migration 113) -- puppeteer click
// test against the REAL extracted Staff modal markup/functions, real
// Chrome, real clicks.
//
// Flow: the Staff edit modal's "Pay Type" control. Picking Salaried
// while Work Type is Admin/Office visibly disables the Pay Rate
// field; picking Hourly re-enables it. Switching Work Type to Admin
// while Pay Type is already Salaried also disables it (the
// re-check-on-work-type-change path). Critically: a FIELD employee
// set to Salaried pay type must NOT have their Pay Rate field
// touched -- only the Admin+Salaried combination is in scope.
//
// Run with: node tests/salaried-admin-pay-type-click.puppeteer.test.js

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
  'Staff modal Work Type + Pay Type + Pay Rate field markup'
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
<html><head><meta charset="utf-8"><title>Salaried Admin pay-type fixture</title></head>
<body>
  ${employmentMarkup}

  <script>
    window.__calls = [];
    ${toggleWorkTypeSrc}
    ${togglePayTypeSrc}
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

  const fixturePath = path.join(os.tmpdir(), 'salaried-admin-pay-type-fixture-' + Date.now() + '.html');
  fs.writeFileSync(fixturePath, FIXTURE_HTML);

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

    await page.goto('file://' + fixturePath, { waitUntil: 'load' });
    check('fixture loaded with no uncaught JS errors', pageErrors, []);

    // ---- Starting state: Work Type = Field (default), Pay Type = Hourly (default) ----
    check('Pay Rate field starts enabled', await page.$eval('#staff-pay', (el) => el.disabled), false);
    check('the Salaried hint starts hidden', await page.$eval('#staff-pay-type-hint', (el) => el.style.display), 'none');

    // ---- Switching Pay Type to Salaried while Work Type is still Field: no effect on Pay Rate ----
    await page.select('#staff-pay-type', 'salary');
    check('a salaried FIELD employee keeps the Pay Rate field enabled (out of scope)', await page.$eval('#staff-pay', (el) => el.disabled), false);
    check('no Salaried hint shown for a salaried field employee', await page.$eval('#staff-pay-type-hint', (el) => el.style.display), 'none');

    // ---- Now switch Work Type to Admin/Office too: the Admin+Salaried combo kicks in ----
    await page.select('#staff-work-type', 'admin');
    check('switching to Admin/Office while already Salaried disables the Pay Rate field', await page.$eval('#staff-pay', (el) => el.disabled), true);
    check('the Pay Rate field dims visually', await page.$eval('#staff-pay-rate-field', (el) => el.style.opacity), '0.4');
    check('the Salaried hint becomes visible', await page.$eval('#staff-pay-type-hint', (el) => el.style.display), '');

    // ---- Switching Pay Type back to Hourly (still Admin/Office) re-enables it ----
    await page.select('#staff-pay-type', 'hourly');
    check('switching back to Hourly re-enables the Pay Rate field', await page.$eval('#staff-pay', (el) => el.disabled), false);
    check('the Pay Rate field opacity resets', await page.$eval('#staff-pay-rate-field', (el) => el.style.opacity), '1');
    check('the Salaried hint hides again', await page.$eval('#staff-pay-type-hint', (el) => el.style.display), 'none');

    // ---- Salaried again (still Admin/Office): disabled once more ----
    await page.select('#staff-pay-type', 'salary');
    check('re-selecting Salaried while Admin/Office disables the Pay Rate field again', await page.$eval('#staff-pay', (el) => el.disabled), true);

    // ---- Switching Work Type back to Field (still Salaried) re-enables Pay Rate ----
    await page.select('#staff-work-type', 'field');
    check('switching back to Field re-enables the Pay Rate field even though Pay Type is still Salaried', await page.$eval('#staff-pay', (el) => el.disabled), false);
    check('the Salaried hint hides once Work Type is Field again', await page.$eval('#staff-pay-type-hint', (el) => el.style.display), 'none');

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
