// Puppeteer click test: tapping "✕ Not lunch" on a stop inside the Team
// Hours modal's GPS activity timeline. Exercises the REAL markup and
// REAL functions in a real browser -- the modal's static HTML, the
// shared _renderGPSStopRow (same one Live's renderGPS uses -- see
// team-hours-gps-timeline-shared-renderer.test.js for the proof that
// it's genuinely shared, not a second copy), the shared
// _toggleLunchOverride writer, and _teamHoursAfterLunchToggle's refresh.
//
// Scope note, same as team-hours-button-click.puppeteer.test.js: no live
// Supabase/Geotab session. _fetchTeamDayGpsDetail (the Geotab fetch) and
// _computeGpsHoursFromTrips (the GPS-hours algorithm -- its own
// correctness is covered by tests/gps-hours-decoupled-start-end.test.js
// and tests/lunch-detection-bounded.test.js) are mocked; PentaLunchFlags
// is a small in-memory fake standing in for the real Supabase-backed
// facade. Everything downstream of those two boundaries -- the DOM, the
// click handlers, _toggleLunchOverride, _teamHoursAfterLunchToggle -- is
// the real, unmodified source extracted from index.html.
//
// Run with: node tests/team-hours-gps-not-lunch-click.puppeteer.test.js

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

// _teamHoursEligibility through _teamHoursRefreshAfterWrite -- the
// whole modal module, including _teamHoursRenderGpsTimeline and
// _teamHoursAfterLunchToggle.
const teamHoursSrc = extract(
  'function _teamHoursEligibility(team, dateStr) {',
  '\n\n// PR #118',
  'Team Hours modal module'
);

const toggleLunchSrc = extract(
  'async function _toggleLunchOverride(team, dateStr, stopKey, action, addr, durationMin, afterRefreshFn) {',
  '\n\n// PR #114',
  '_toggleLunchOverride'
);

const renderRowSrc = extract(
  'function _renderGPSStopRow(s, includeDriveInfo, ctx) {',
  '\n\nfunction renderGPS() {',
  '_renderGPSStopRow'
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

// A single non-depot, unmatched, 30-minute stop -- qualifies as
// "naturally lunch" under _renderGPSStopRow's own rule (no client
// match, 0 < duration < 60min), so the real "✕ Not lunch" button
// actually renders, exactly as it would for a real such stop on Live.
const STOP_KEY = '2026-09-10T17:30:00.000Z';
const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Team Hours GPS timeline fixture</title></head>
<body>
  <button id="test-hours-btn" onclick="openTeamHoursModal('B1','2026-09-10')" style="margin:40px">🕐 Hours</button>

  ${overlayMarkup}

  <script>
    window.__calls = [];
    window.__alerts = [];
    window.alert = function(msg) { window.__alerts.push(msg); };

    window.PentaHourOverrides = {};

    // Small in-memory fake standing in for the real Supabase-backed
    // PentaLunchFlags facade (migration 101) -- same shape/contract
    // (getOverride/setOverride/clearOverride), so the REAL
    // _toggleLunchOverride's write path runs unmodified against it.
    window.PentaLunchFlags = {
      _rows: {},
      _key: function(team, dateStr, stopKey) { return team + '|' + dateStr + '|' + stopKey; },
      getOverride: function(team, dateStr, stopKey) { return this._rows[this._key(team, dateStr, stopKey)] || null; },
      setOverride: function(team, dateStr, stopKey, overrideType) {
        this._rows[this._key(team, dateStr, stopKey)] = { override_type: overrideType };
        window.__calls.push(['PentaLunchFlags.setOverride', team, dateStr, stopKey, overrideType]);
        return Promise.resolve();
      },
      clearOverride: function(team, dateStr, stopKey) {
        delete this._rows[this._key(team, dateStr, stopKey)];
        window.__calls.push(['PentaLunchFlags.clearOverride', team, dateStr, stopKey]);
        return Promise.resolve();
      },
    };
    var PentaLunchFlags = window.PentaLunchFlags; // _toggleLunchOverride calls the bare global, same as Live's own code does

    function _adjustWeekHoursLunch() { window.__calls.push(['_adjustWeekHoursLunch']); }
    function _auditSupplement(actionType, entityType, entityId, newValues) {
      window.__calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    }
    // renderGPS deliberately NOT defined -- _toggleLunchOverride guards
    // it with typeof, same as Live's own code; this fixture has no Live
    // tab DOM to render into.

    var ROSTER = [
      { id: 'e1', name: 'Alice', uuid: 'u1', defaultTeam: 'B1' },
    ];
    function getUnifiedRoster() { return ROSTER.slice(); }
    function getEmployeeTeam(id) { var e = ROSTER.find(function(r) { return r.id === id; }); return e ? e.defaultTeam : null; }
    function getRosterTermData() { return {}; }
    function getEmployeeDayOffInfo() { return null; }
    var DAY_OFF_CATEGORY_LABELS = {};
    function _adminEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function dateKey(d) { return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10); }
    function matchStopToClientGeo() { return null; } // no client on file -- lets the stop qualify as naturallyLunch
    function _pentaBusinessTimezone() { return 'America/New_York'; }
    function _bizHM(date) { return date.toISOString().substr(11, 5); }
    var jobs = [];
    var weekHours, hoursWeekOffset; // left undefined -- _teamHoursRefreshAfterWrite's loadWeekHours branch no-ops
    function renderTeamManager() { window.__calls.push(['renderTeamManager']); return Promise.resolve(); }
    function loadWeekHours() { window.__calls.push(['loadWeekHours']); return Promise.resolve(); }

    // One naturally-lunch-qualifying stop. _fetchTeamDayGpsDetail (the
    // Geotab fetch) is mocked -- this test is about the click/write/
    // refresh wiring, not re-proving the Geotab round trip
    // (team-hours-button-click.puppeteer.test.js already covers that
    // the fetch itself can fail gracefully without blocking Apply).
    var CANNED_STOP = { addr: '123 Side St', inTime: new Date('${STOP_KEY}'), outTime: new Date('2026-09-10T18:00:00Z') };
    var FETCH_CALLS = 0;
    async function _fetchTeamDayGpsDetail(team, dateStr) {
      FETCH_CALLS++;
      window.__calls.push(['_fetchTeamDayGpsDetail', team, dateStr]);
      return {
        device: { id: 'dev-1' },
        trips: [{ start: '2026-09-10T13:00:00Z', stop: '2026-09-10T21:00:00Z' }],
        stopList: [CANNED_STOP],
        gps: _computeGpsHoursFromTrips(null, team, dateStr),
      };
    }
    // Deterministic stand-in for the real algorithm (its own correctness
    // has its own tests) -- reads the SAME PentaLunchFlags state the
    // real _detectDayLunch would, so a real toggle produces a real,
    // visibly different number here too.
    function _computeGpsHoursFromTrips(trips, team, dateStr) {
      var ov = PentaLunchFlags.getOverride(team, dateStr, '${STOP_KEY}');
      var excluded = ov && ov.override_type === 'exclude';
      return {
        available: true,
        start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'),
        lunchMin: excluded ? 0 : 30, hours: excluded ? 8 : 7.5
      };
    }

    ${renderRowSrc}
    ${toggleLunchSrc}
    ${teamHoursSrc}
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

  const fixturePath = path.join(os.tmpdir(), 'team-hours-gps-not-lunch-fixture-' + Date.now() + '.html');
  fs.writeFileSync(fixturePath, FIXTURE_HTML);

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

    await page.goto('file://' + fixturePath, { waitUntil: 'load' });
    check('fixture loaded with no uncaught JS errors', pageErrors, []);

    await page.click('#test-hours-btn');
    await page.waitForSelector('#team-hours-overlay', { visible: true });
    await page.waitForFunction(() => /Not lunch/.test(document.getElementById('team-hours-gps-timeline').innerHTML));

    check('the GPS summary initially shows 30m lunch', await page.$eval('#team-hours-gps-summary', (el) => /Lunch 30m/.test(el.innerHTML)), true);
    check('the real "✕ Not lunch" button rendered for the qualifying stop', await page.$eval('#team-hours-gps-timeline', (el) => /Not lunch/.test(el.innerHTML)), true);
    check('the stop shows the "Possible lunch / break" flag', await page.$eval('#team-hours-gps-timeline', (el) => /Possible lunch/.test(el.innerHTML)), true);

    // Fields start at the GPS prefill (30m lunch) before any click.
    check('Lunch field is prefilled from GPS (30)', await page.$eval('#team-hours-lunch', (el) => el.value), '30');

    // Real click on the real button.
    const notLunchBtn = await page.$('#team-hours-gps-timeline button');
    await notLunchBtn.click();
    await page.waitForFunction(() => /Lunch 0m/.test(document.getElementById('team-hours-gps-summary').innerHTML));

    const calls = await page.evaluate(() => window.__calls);
    check('the write went through the shared PentaLunchFlags.setOverride (team-scoped, that date)',
      calls.some((c) => c[0] === 'PentaLunchFlags.setOverride' && c[1] === 'B1' && c[2] === '2026-09-10' && c[4] === 'exclude'), true);
    check('an audit_log supplement was written for the toggle', calls.some((c) => c[0] === '_auditSupplement'), true);
    check('no second Geotab fetch happened for the toggle (only the initial modal-open fetch)',
      calls.filter((c) => c[0] === '_fetchTeamDayGpsDetail').length, 1);
    check('the GPS summary updated to the new (excluded) lunch value', await page.$eval('#team-hours-gps-summary', (el) => /Lunch 0m/.test(el.innerHTML)), true);
    check('the timeline re-rendered showing the "Marked not-lunch" state', await page.$eval('#team-hours-gps-timeline', (el) => /Marked not-lunch/.test(el.innerHTML)), true);
    check('the Lunch field was refreshed to match (Tom never typed into it)', await page.$eval('#team-hours-lunch', (el) => el.value), '0');
    check('Live hours refresh ran (renderTeamManager, same path every other write uses)', calls.some((c) => c[0] === 'renderTeamManager'), true);

    // Re-render produced a "Mark as lunch" undo button -- click it and
    // confirm the flag reverses cleanly.
    const markLunchBtn = await page.$('#team-hours-gps-timeline button');
    await markLunchBtn.click();
    await page.waitForFunction(() => /Lunch 30m/.test(document.getElementById('team-hours-gps-summary').innerHTML));
    check('reversing clears the override (PentaLunchFlags.clearOverride)', await page.evaluate(() => window.__calls.some((c) => c[0] === 'PentaLunchFlags.clearOverride')), true);
    check('the Lunch field reflects the reversal (back to 30)', await page.$eval('#team-hours-lunch', (el) => el.value), '30');

    // Now prove the "don't clobber typed fields" rule end-to-end: type a
    // custom lunch value, then toggle again -- the field must NOT snap
    // back to the GPS number, even though the summary still updates.
    await page.$eval('#team-hours-lunch', (el) => { el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const notLunchBtn2 = await page.$('#team-hours-gps-timeline button');
    await notLunchBtn2.click();
    await page.waitForFunction(() => /Lunch 0m/.test(document.getElementById('team-hours-gps-summary').innerHTML));
    check('typing into Lunch first, then toggling, leaves the typed value untouched', await page.$eval('#team-hours-lunch', (el) => el.value), '45');
    check('...while the GPS summary reference still updates underneath it', await page.$eval('#team-hours-gps-summary', (el) => /Lunch 0m/.test(el.innerHTML)), true);

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
