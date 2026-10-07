// Team Hours modal's GPS activity timeline: tapping "Not lunch" (or
// "Mark as lunch") on a stop inside the modal must refresh the modal's
// own GPS summary/timeline from the ALREADY-cached trips (no second
// Geotab call -- PentaLunchFlags' cache is already updated by the time
// _toggleLunchOverride resolves, same pattern as every other PentaX
// facade here), and must only overwrite the Start/End/Lunch fields with
// the new "GPS says" numbers when Tom hasn't typed into them himself.
// If he has, those fields stay exactly as he left them -- only the
// reference text (the GPS summary line + timeline) updates, per Tom's
// explicit rule.
//
// This test exercises _teamHoursAfterLunchToggle directly (the function
// _toggleLunchOverride's optional 7th-param callback invokes after a
// successful write) against the REAL extracted source, mocking the
// pure-computation boundary (_computeGpsHoursFromTrips -- its own
// correctness has its own tests) and the DOM.
//
// Run with: node tests/team-hours-gps-not-lunch-refresh.test.js

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

// _teamHoursRenderGpsTimeline + _teamHoursAfterLunchToggle -- contiguous
// in the file, ending right before openTeamHoursModal.
const fnSource = extract(
  'function _teamHoursRenderGpsTimeline(detail, team, dateStr) {',
  '\n\nasync function openTeamHoursModal',
  '_teamHoursRenderGpsTimeline + _teamHoursAfterLunchToggle'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const els = {
    'team-hours-overlay': {
      style: { display: opts.overlayDisplay !== undefined ? opts.overlayDisplay : 'flex' },
      dataset: { team: opts.overlayTeam !== undefined ? opts.overlayTeam : 'B1', date: opts.overlayDate !== undefined ? opts.overlayDate : '2026-09-10', userEdited: opts.userEdited ? 'true' : 'false' },
      _gpsDetail: opts.gpsDetail !== undefined ? opts.gpsDetail : {
        device: { id: 'dev-1' },
        trips: [{ start: '2026-09-10T13:00:00Z', stop: '2026-09-10T21:00:00Z' }],
        stopList: [{ addr: 'Somewhere', inTime: null, outTime: new Date('2026-09-10T13:00:00Z') }],
        gps: { available: true, start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'), lunchMin: 30, hours: 7.5 },
      },
    },
    'team-hours-gps-summary': { innerHTML: '' },
    'team-hours-gps-timeline': { innerHTML: '' },
    'team-hours-start': { value: opts.startValue !== undefined ? opts.startValue : '09:00' },
    'team-hours-end': { value: opts.endValue !== undefined ? opts.endValue : '17:00' },
    'team-hours-lunch': { value: opts.lunchValue !== undefined ? opts.lunchValue : '30' },
  };
  const sandbox = {
    console,
    document: { getElementById: (id) => Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null },
    jobs: [],
    _adminEsc: (s) => String(s == null ? '' : s),
    _pentaBusinessTimezone: () => 'America/New_York',
    // Deterministic, not tz-real -- _bizHM's own tz-correctness has its
    // own test (team-hours-button-apply-rollback.test.js); this just
    // needs to be a recognizable, distinct string per Date so the
    // "did the summary/fields change" assertions are meaningful.
    _bizHM: (date) => date.toISOString().substr(11, 5),
    // Stub -- row HTML content isn't what this test is about; the
    // shared-renderer identity itself has its own test
    // (team-hours-gps-timeline-shared-renderer.test.js).
    _renderGPSStopRow: (s, includeDriveInfo, ctx) => { calls.push(['_renderGPSStopRow', ctx.afterToggleFn]); return '<row>'; },
    // Boundary: the pure recompute _teamHoursAfterLunchToggle calls
    // after a lunch-flag change. Returns whatever this test's opts say,
    // so a "before" vs "after" toggle can look different.
    _computeGpsHoursFromTrips: (trips, team, dateStr) => {
      calls.push(['_computeGpsHoursFromTrips', team, dateStr]);
      return opts.recomputedGps || { available: true, start: new Date('2026-09-10T12:30:00Z'), end: new Date('2026-09-10T20:45:00Z'), lunchMin: 0, hours: 8.25 };
    },
    _teamHoursRefreshAfterWrite: (dateStr) => { calls.push(['_teamHoursRefreshAfterWrite', dateStr]); return Promise.resolve(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, els, calls };
}

async function main() {
  // ---- userEdited=false: GPS fields ARE refreshed to the new numbers ----
  {
    const { sandbox, els, calls } = buildSandbox({ userEdited: false, startValue: '09:00', endValue: '17:00', lunchValue: '30' });
    await sandbox._teamHoursAfterLunchToggle('B1', '2026-09-10');
    check('the pure recompute runs (no second Geotab fetch -- just _computeGpsHoursFromTrips on cached trips)',
      calls.some((c) => c[0] === '_computeGpsHoursFromTrips'), true);
    check('Start field is refreshed to the new GPS value', els['team-hours-start'].value, '12:30');
    check('End field is refreshed to the new GPS value', els['team-hours-end'].value, '20:45');
    check('Lunch field is refreshed to the new GPS value', els['team-hours-lunch'].value, '0');
    check('the timeline re-renders from the cached stopList (uses _renderGPSStopRow, not a refetch)',
      calls.some((c) => c[0] === '_renderGPSStopRow'), true);
    check('Live hours refresh is triggered for this date', calls.some((c) => c[0] === '_teamHoursRefreshAfterWrite' && c[1] === '2026-09-10'), true);
  }

  // ---- userEdited=true: fields are LEFT ALONE, only the reference updates ----
  {
    const { sandbox, els, calls } = buildSandbox({ userEdited: true, startValue: '10:15', endValue: '18:00', lunchValue: '45' });
    await sandbox._teamHoursAfterLunchToggle('B1', '2026-09-10');
    check('Start field keeps Tom\'s typed value, not the new GPS number', els['team-hours-start'].value, '10:15');
    check('End field keeps Tom\'s typed value', els['team-hours-end'].value, '18:00');
    check('Lunch field keeps Tom\'s typed value', els['team-hours-lunch'].value, '45');
    check('the recompute still runs (the reference/summary must still update)', calls.some((c) => c[0] === '_computeGpsHoursFromTrips'), true);
    check('the timeline still re-renders (shows the new "GPS says" reference even though fields are untouched)',
      calls.some((c) => c[0] === '_renderGPSStopRow'), true);
    check('the GPS summary line reflects the NEW numbers (the reference, not the stale ones)',
      /12:30/.test(els['team-hours-gps-summary'].innerHTML) && /20:45/.test(els['team-hours-gps-summary'].innerHTML), true);
  }

  // ---- Stale guard: toggle fired for a team/date that isn't what's currently open ----
  {
    const { sandbox, els, calls } = buildSandbox({ overlayTeam: 'B1', overlayDate: '2026-09-10', userEdited: false });
    await sandbox._teamHoursAfterLunchToggle('S3', '2026-09-11'); // different team+date than what's open
    check('nothing recomputes for a stale/mismatched toggle', calls.length, 0);
    check('fields are untouched', els['team-hours-start'].value, '09:00');
  }

  // ---- Modal not open: toggle fired after the modal was closed ----
  {
    const { sandbox, calls } = buildSandbox({ overlayDisplay: 'none' });
    await sandbox._teamHoursAfterLunchToggle('B1', '2026-09-10');
    check('nothing happens when the modal is closed', calls.length, 0);
  }

  // ---- No cached GPS detail yet (toggle somehow fired before the initial fetch resolved) ----
  {
    const { sandbox, calls } = buildSandbox({ gpsDetail: null });
    await sandbox._teamHoursAfterLunchToggle('B1', '2026-09-10');
    check('a missing cache degrades to a no-op, not a throw', calls.length, 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
