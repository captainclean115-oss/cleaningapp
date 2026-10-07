// Puppeteer click test for the Team Hours modal ("🕐 Hours" button on a
// team header, Team Manager modal). tests/team-hours-button-apply-
// rollback.test.js already covers the write/validate/rollback logic in
// a Node vm sandbox (no DOM); this test is the complement -- a REAL
// browser, clicking the REAL markup extracted byte-for-byte from
// index.html, to catch what a vm sandbox can't: the button being
// genuinely clickable, the modal's z-index actually winning the
// stacking context above the Teams modal it opens from (the exact bug
// class terminate-modal-zindex-stacking.test.js documents for a sibling
// modal), and the Apply/Reset buttons actually wired to the real
// functions via onclick, not a parallel reimplementation.
//
// Scope note: this does NOT boot the full app (Supabase session,
// Geotab, PentaEmployees hydrate, etc.) -- that needs live credentials
// this environment doesn't have. It extracts the real
// #team-hours-overlay markup and the real JS functions
// (openTeamHoursModal, teamHoursApply, teamHoursResetToGps, and their
// helpers) straight out of index.html via the same marker-extraction
// technique every other test in this directory already uses, drops
// them into a minimal fixture page with mocked data/write functions
// (same mocks as the vm test), and drives it with real mouse clicks.
// Verifying the write actually lands in production Supabase end-to-end
// needs a real logged-in session against the real app and is called
// out separately as a follow-up, not claimed here.
//
// Requires: Chrome installed locally (puppeteer-core, not puppeteer --
// no bundled Chromium download). Run with:
//   node tests/team-hours-button-click.puppeteer.test.js

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

const overlayMarkup = extract(
  '<div id="team-hours-overlay"',
  '\n\n\n<!-- ═══ STAFF EDITOR MODAL ═══ -->',
  'team-hours-overlay markup'
);

const fnSource = extract(
  'function _teamHoursEligibility(team, dateStr) {',
  '\n\n// PR #118',
  'Team Hours modal logic block'
);

const calcHoursFromTimesSrc = extract(
  'function calcHoursFromTimes(startStr, endStr, lunchMins) {',
  '\n\nfunction showEmpDayDetail',
  'calcHoursFromTimes'
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
<html><head><meta charset="utf-8"><title>Team Hours modal fixture</title></head>
<body>
  <!-- Stand-in for the live Teams modal (#team-manager-overlay, z-index:500 in
       index.html) this button/modal actually opens from -- present so the
       z-index stacking assertion below is a real hit-test, not a tautology. -->
  <div id="fake-teams-modal" style="position:fixed;inset:0;z-index:500;background:#300;color:#fff">
    <button id="test-hours-btn" onclick="openTeamHoursModal('B1','2026-09-10')" style="margin:40px">🕐 Hours</button>
  </div>

  ${overlayMarkup}

  <script>
    window.__calls = [];
    window.__overrides = {};
    window.__alerts = [];
    window.alert = function(msg) { window.__alerts.push(msg); };

    window.PentaHourOverrides = {}; // just needs to be truthy for the dependency guards

    var ROSTER = [
      { id: 'e1', name: 'Alice', uuid: 'uuid-alice', defaultTeam: 'B1' },
      { id: 'e2', name: 'Bob',   uuid: 'uuid-bob',   defaultTeam: 'B1' },
      { id: 'e3', name: 'Cara',  uuid: 'uuid-cara',  defaultTeam: 'B1' },
      { id: 'e4', name: 'Dana',  uuid: 'uuid-dana',  defaultTeam: 'B1' },
    ];

    function getUnifiedRoster() { return ROSTER.slice(); }
    function getEmployeeTeam(empId) {
      if (empId === 'e3' || empId === 'e4') return null;
      var e = ROSTER.find(function(r) { return r.id === empId; });
      return e ? e.defaultTeam : null;
    }
    function getRosterTermData() { return { e4: { status: 'terminated' } }; }
    function getEmployeeDayOffInfo(empId) { return empId === 'e3' ? { status_type: 'vacation' } : null; }
    var DAY_OFF_CATEGORY_LABELS = { vacation: 'Vacation' };
    function _adminEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    ${calcHoursFromTimesSrc}

    // GPS-prefill helpers are stubbed, not under test here -- the real
    // business-timezone-correctness of _bizHM/_bizWallClockToUtc is
    // covered directly in team-hours-button-apply-rollback.test.js.
    // Without window.supabaseClient/PentaTenant set, _computeTeamDayGpsHours
    // falls through to its blank-prefill return path, which is all this
    // click test needs -- it's exercising Apply/Reset, not the prefill.
    function _pentaBusinessTimezone() { return 'America/New_York'; }
    function _bizWallClockToUtc(y, m, d, hh, mm, ss) { return new Date(Date.UTC(y, m - 1, d, hh, mm, ss)); }
    function _bizHM(date) { return date.toISOString().substr(11, 5); }

    function getEmpHours(empId) { window.__calls.push(['getEmpHours', empId]); return window.__overrides[empId] || null; }
    function saveEmpHours(empId, dateStr, data) {
      window.__calls.push(['saveEmpHours', empId, dateStr, data]);
      window.__overrides[empId] = data;
      return Promise.resolve();
    }
    function clearEmpHours(empId) {
      window.__calls.push(['clearEmpHours', empId]);
      delete window.__overrides[empId];
      return Promise.resolve();
    }
    function _auditSupplement(actionType, entityType, entityId, newValues) {
      window.__calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    }
    function logPendingUpdate(action, details) { window.__calls.push(['logPendingUpdate', action, details]); }
    function renderTeamManager() { window.__calls.push(['renderTeamManager']); return Promise.resolve(); }
    function loadWeekHours() { window.__calls.push(['loadWeekHours']); return Promise.resolve(); }
    function getWeekDates() { return []; }
    function dateKey(d) { return d; }
    var weekHours, hoursWeekOffset;

    ${fnSource}
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

  const fixturePath = path.join(os.tmpdir(), 'team-hours-modal-fixture-' + Date.now() + '.html');
  fs.writeFileSync(fixturePath, FIXTURE_HTML);

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

    await page.goto('file://' + fixturePath, { waitUntil: 'load' });

    check('fixture loaded with no uncaught JS errors', pageErrors.filter(function(e) { return !/warn/i.test(e); }), []);

    // Modal starts closed.
    check('modal starts hidden', await page.$eval('#team-hours-overlay', (el) => el.style.display), 'none');

    // Click the real "🕐 Hours" button.
    await page.click('#test-hours-btn');
    await page.waitForSelector('#team-hours-overlay', { visible: true });
    check('clicking the Hours button opens the modal', await page.$eval('#team-hours-overlay', (el) => el.style.display), 'flex');
    check('title shows the team and date', await page.$eval('#team-hours-title', (el) => el.textContent.includes('B1')), true);
    check('Will-be-changed list shows Alice and Bob', await page.$eval('#team-hours-included', (el) => el.textContent), 'Alice, Bob');
    check('Skipped list shows Cara (Vacation) and Dana (Terminated)', await page.$eval('#team-hours-skipped', (el) => el.textContent), 'Cara (Vacation), Dana (Terminated)');

    // Real hit-test: a click inside the modal's content must land on the
    // modal, not the fake Teams modal (z-index:500) it visually sits on
    // top of -- the exact bug class PR #(terminate-modal-zindex-stacking)
    // documents for a sibling modal.
    const applyBox = await page.$eval('#team-hours-apply-btn', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const hitTarget = await page.evaluate((x, y) => {
      const el = document.elementFromPoint(x, y);
      return !!(el && el.closest('#team-hours-overlay'));
    }, applyBox.x, applyBox.y);
    check('the Apply button is actually hit-testable above the fake Teams modal (z-index wins)', hitTarget, true);

    // Inverted times (the Maria Vieira case) -- real click on Apply must
    // show a visible error and must NOT close the modal or write anything.
    await page.$eval('#team-hours-start', (el) => (el.value = '21:00'));
    await page.$eval('#team-hours-end', (el) => (el.value = '16:27'));
    await page.click('#team-hours-apply-btn');
    check('inverted times show a visible error', await page.$eval('#team-hours-error', (el) => el.style.display), '');
    check('inverted times keep the modal open', await page.$eval('#team-hours-overlay', (el) => el.style.display), 'flex');
    check('inverted times write nothing', await page.evaluate(() => window.__calls.some((c) => c[0] === 'saveEmpHours')), false);

    // Fix the times and apply for real.
    await page.$eval('#team-hours-start', (el) => (el.value = '08:30'));
    await page.$eval('#team-hours-end', (el) => (el.value = '16:30'));
    await page.$eval('#team-hours-lunch', (el) => (el.value = '30'));
    await page.click('#team-hours-apply-btn');
    await page.waitForFunction(() => document.getElementById('team-hours-overlay').style.display === 'none');
    check('modal closes after a valid Apply', await page.$eval('#team-hours-overlay', (el) => el.style.display), 'none');
    const saveCallCount = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'saveEmpHours').length);
    check('exactly 2 employees written (Alice + Bob; Cara/Dana skipped)', saveCallCount, 2);
    const auditCallCount = await page.evaluate(() =>
      window.__calls.filter((c) => c[0] === '_auditSupplement' && c[4] && c[4].source === 'team_hours_button').length);
    check('one audit_log entry per employee edited, source=team_hours_button', auditCallCount, 2);

    // Re-open and exercise "Reset team to GPS" via a real click.
    await page.evaluate(() => { window.__calls.length = 0; });
    await page.click('#test-hours-btn');
    await page.waitForSelector('#team-hours-overlay', { visible: true });
    await page.click('#team-hours-reset-btn');
    await page.waitForFunction(() => document.getElementById('team-hours-overlay').style.display === 'none');
    const clearCallCount = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'clearEmpHours').length);
    check('Reset clears both included employees\' overrides', clearCallCount, 2);
    const remainingOverrides = await page.evaluate(() => Object.keys(window.__overrides).length);
    check('no overrides remain after reset', remainingOverrides, 0);

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
