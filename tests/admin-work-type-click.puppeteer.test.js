// Admin/Office employee designation (migration 113) -- puppeteer click
// test against the REAL extracted markup/functions, real Chrome, real
// clicks. Two flows:
//   1. The Staff edit modal's "Work Type" control -- picking Admin/
//      Office visibly disables the Team field and shows the hint;
//      picking Field team re-enables it.
//   2. The Admin/Office row's edit-hours flow (showEmpDayDetail called
//      with team=null, same bottom-sheet field employees use) -- no
//      Route button, no Team <select> (a static "Admin" label
//      instead), inverted times rejected with a visible error and NO
//      write, valid times save through the real saveEmpHours path.
//
// Run with: node tests/admin-work-type-click.puppeteer.test.js

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

const workTypeMarkup = extract(
  '<!-- EMPLOYMENT -->',
  '\n        <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Role</div>',
  'Staff modal Work Type + Team field markup'
);
const toggleFnSrc = extract(
  'function _staffToggleTeamFieldForWorkType() {',
  '\n\nfunction openAddStaff() {',
  '_staffToggleTeamFieldForWorkType'
);
const dayDetailSrc = extract(
  'function calcHoursFromTimes(startStr, endStr, lunchMins) {',
  '\n// PR #120 -- showEmpStops previously',
  'calcHoursFromTimes + showEmpDayDetail'
);
const saveHoursSrc = extract(
  'async function saveEmpDayHours(empId, empName, dk) {',
  '\n\nasync function clearEmpDayHours(',
  'saveEmpDayHours'
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
<html><head><meta charset="utf-8"><title>Admin/Office fixture</title></head>
<body>
  <!-- Flow 1: Staff modal Work Type control (real extracted markup). -->
  ${workTypeMarkup}

  <!-- Flow 2: trigger for the Admin/Office edit-hours flow. -->
  <button id="test-admin-day-btn" onclick="showEmpDayDetail('e-linda','Linda',null,${new Date('2026-10-08T00:00:00').getTime()})" style="margin:40px">Open Linda's day</button>

  <script>
    window.__calls = [];
    window.__alerts = [];
    window.alert = function(msg) { window.__alerts.push(msg); };

    ${toggleFnSrc}

    // ---- Flow 2 dependencies (Admin/Office edit-hours) ----
    var weekHours = {}; // never consulted for Admin -- team is null
    var hoursWeekOffset = 0;
    function getWeekDates() { return [new Date('2026-10-08T00:00:00')]; }
    function dateKey(d) { return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10); }
    function _audEsc(s) { return String(s == null ? '' : s); }
    var __overrides = {};
    function getEmpHours(empId, dk) { return (__overrides[empId] && __overrides[empId][dk]) || null; }
    function saveEmpHours(empId, dk, data) {
      window.__calls.push(['saveEmpHours', empId, dk, data]);
      if (!__overrides[empId]) __overrides[empId] = {};
      __overrides[empId][dk] = data;
      return Promise.resolve();
    }
    function clearEmpHours(empId, dk) { window.__calls.push(['clearEmpHours', empId, dk]); delete (__overrides[empId] || {})[dk]; return Promise.resolve(); }
    function getEmpTasks() { return []; }
    function renderEmpTasks() { window.__calls.push(['renderEmpTasks']); }
    function showAddTaskMenu() {}
    function logPendingUpdate() { window.__calls.push(['logPendingUpdate']); }
    function loadWeekHours() { window.__calls.push(['loadWeekHours']); return Promise.resolve(); }
    // Real GPS helpers are never reached for Admin (isAdmin branch), but
    // defined anyway so a regression that accidentally calls them fails
    // loudly in __calls rather than throwing ReferenceError and masking
    // the real assertion.
    function openHoursRouteDetail() { window.__calls.push(['openHoursRouteDetail']); }
    function showEmpStops() { window.__calls.push(['showEmpStops']); }
    function onEmpTeamChange() { window.__calls.push(['onEmpTeamChange']); }
    function _pentaTeamColor(t, fallback) { return fallback || '#000'; }
    function _pentaTeamNames() { return ['B1', 'S3']; }

    ${dayDetailSrc}
    ${saveHoursSrc}
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

  const fixturePath = path.join(os.tmpdir(), 'admin-work-type-fixture-' + Date.now() + '.html');
  fs.writeFileSync(fixturePath, FIXTURE_HTML);

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

    await page.goto('file://' + fixturePath, { waitUntil: 'load' });
    check('fixture loaded with no uncaught JS errors', pageErrors, []);

    // ---- Flow 1: Work Type control ----
    check('Team field starts enabled (Work Type defaults to Field)', await page.$eval('#staff-team', (el) => el.disabled), false);
    check('the Admin hint starts hidden', await page.$eval('#staff-work-type-hint', (el) => el.style.display), 'none');

    await page.select('#staff-work-type', 'admin');
    check('picking Admin/Office disables the Team <select>', await page.$eval('#staff-team', (el) => el.disabled), true);
    check('picking Admin/Office dims the Team field visually', await page.$eval('#staff-team-field', (el) => el.style.opacity), '0.4');
    check('the Admin hint becomes visible', await page.$eval('#staff-work-type-hint', (el) => el.style.display), '');

    await page.select('#staff-work-type', 'field');
    check('switching back to Field re-enables the Team <select>', await page.$eval('#staff-team', (el) => el.disabled), false);
    check('the Admin hint hides again', await page.$eval('#staff-work-type-hint', (el) => el.style.display), 'none');

    // ---- Flow 2: Admin/Office edit-hours ----
    await page.click('#test-admin-day-btn');
    await page.waitForSelector('#emp-hours-overlay');

    check('the Team field shows a static "Admin" label, not a reassignment <select>', await page.$eval('#emp-hr-team', (el) => el.tagName), 'DIV');
    check('the static Team label reads Admin', await page.$eval('#emp-hr-team', (el) => /Admin/.test(el.textContent)), true);
    check('no GPS Route button renders for Admin/Office', (await page.$$('button')).length > 0 &&
      await page.evaluate(() => !Array.from(document.querySelectorAll('button')).some((b) => /Route/.test(b.textContent))), true);
    check('no GPS stops area renders for Admin/Office', await page.evaluate(() => !document.getElementById('emp-stops-area')), true);
    check('Hours shows blank ("—"), not "0.0", since there is no override yet', await page.$eval('#emp-hr-calc', (el) => el.textContent), '—');

    // Inverted times (the Maria Vieira case): 21:00 -> 16:27 must be impossible.
    await page.$eval('#emp-hr-start', (el) => (el.value = '21:00'));
    await page.$eval('#emp-hr-end', (el) => (el.value = '16:27'));
    await page.click('#emp-hours-overlay button[onclick^="saveEmpDayHours"]');
    let calls = await page.evaluate(() => window.__calls);
    check('inverted times write nothing at all', calls.some((c) => c[0] === 'saveEmpHours'), false);
    const alerts1 = await page.evaluate(() => window.__alerts);
    check('a visible alert explains the inverted-time rejection', alerts1.some((a) => /End time must be after start time/.test(a)), true);

    // Fix the times and save for real.
    await page.evaluate(() => { window.__alerts.length = 0; });
    await page.$eval('#emp-hr-start', (el) => (el.value = '09:00'));
    await page.$eval('#emp-hr-end', (el) => (el.value = '17:00'));
    await page.$eval('#emp-hr-lunch', (el) => (el.value = '30'));
    await page.click('#emp-hours-overlay button[onclick^="saveEmpDayHours"]');
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'saveEmpHours'));
    calls = await page.evaluate(() => window.__calls);
    const saveCall = calls.find((c) => c[0] === 'saveEmpHours');
    check('the real saveEmpHours is called with the entered values', saveCall[3], { start: '09:00', end: '17:00', lunch: 30, hours: 7.5, team: 'Admin' });
    check('the Team on the written row is explicitly "Admin", not undefined/blank', saveCall[3].team, 'Admin');
    check('no GPS functions were ever touched for this employee', calls.some((c) => c[0] === 'showEmpStops' || c[0] === 'openHoursRouteDetail'), false);

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
