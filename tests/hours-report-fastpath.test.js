// _buildHoursReportForDates(dates) must reuse the already-loaded global
// weekHours (no extra Geotab calls) when the requested range is EXACTLY
// the Hours tab's current week, and only fall through to the live
// _computeHoursForDateRange computation for any other range (last
// week, a custom range, etc) -- this is the fast-path/slow-path split
// that keeps the common "export what I'm already looking at on the
// Hours tab" case exactly as fast as the pre-existing behavior.
//
// Extracts the real _buildHoursReportForDates verbatim and mocks
// _computeHoursForDateRange/_buildHoursReportFromData/getWeekDates at
// the boundary -- each already has its own dedicated test elsewhere.
//
// Run with: node tests/hours-report-fastpath.test.js

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

const fnSrc = extract('async function _buildHoursReportForDates(dates) {', '\n\n// Generalizes _loadWeekHoursInner');

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const sandbox = {
    console,
    weekHours: opts.weekHours || {},
    hoursWeekOffset: 0,
    dateKey: function (d) { var dt = (d instanceof Date) ? d : new Date(d); return dt.toISOString().slice(0, 10); },
    getWeekDates: opts.getWeekDates || function () { return [new Date('2026-09-07'), new Date('2026-09-08'), new Date('2026-09-09'), new Date('2026-09-10'), new Date('2026-09-11')]; },
    _pentaTeamNames: function () { return ['B1']; },
    _computeHoursForDateRange: function (dates) {
      calls.push(['_computeHoursForDateRange', dates]);
      return Promise.resolve({ B1: { days: dates.map(function () { return 5; }), starts: dates.map(function () { return null; }), ends: dates.map(function () { return null; }), lunch: dates.map(function () { return null; }), total: 5 * dates.length } });
    },
    _buildHoursReportFromData: function (dates, weekHoursData, teams) {
      calls.push(['_buildHoursReportFromData', dates, weekHoursData.B1.days]);
      return { text: 'REPORT', csv: 'csv', filename: 'f.csv', weekLabel: 'label', grandHours: weekHoursData.B1.total, empsSeen: 1 };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc, sandbox);
  return { sandbox, calls };
}

async function main() {
  // ---- Requested range matches the current Hours-tab week exactly --
  // reuse global weekHours, no live computation call at all. ----
  {
    const { sandbox, calls } = buildSandbox({
      weekHours: { B1: { days: [1, 2, 3, 4, 5], starts: [null, null, null, null, null], ends: [null, null, null, null, null], lunch: [null, null, null, null, null], total: 15 } },
    });
    const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
    await sandbox._buildHoursReportForDates(dates);
    check('the live computation is NEVER called for the current-week fast path', calls.some(function (c) { return c[0] === '_computeHoursForDateRange'; }), false);
    const builderCall = calls.find(function (c) { return c[0] === '_buildHoursReportFromData'; });
    check('the reused weekHours values are passed through unchanged', builderCall[2], [1, 2, 3, 4, 5]);
  }

  // ---- Requested range is NOT the current Hours-tab week (e.g. "last
  // week" from the Live tab) -- must compute fresh, never silently
  // reuse the wrong week's cached data. ----
  {
    const { sandbox, calls } = buildSandbox({
      weekHours: { B1: { days: [1, 2, 3, 4, 5], starts: [null, null, null, null, null], ends: [null, null, null, null, null], lunch: [null, null, null, null, null], total: 15 } },
    });
    const dates = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'];
    await sandbox._buildHoursReportForDates(dates);
    const computeCall = calls.find(function (c) { return c[0] === '_computeHoursForDateRange'; });
    check('a different range triggers the live computation', !!computeCall, true);
    check('the live computation is called with the REQUESTED dates, not the stale current week', computeCall[1], dates);
    const builderCall = calls.find(function (c) { return c[0] === '_buildHoursReportFromData'; });
    check('the freshly computed values (not the stale current-week weekHours) are used', builderCall[2], dates.map(function () { return 5; }));
  }

  // ---- weekHours is empty (Hours tab never loaded this session) --
  // even a range that would otherwise "match" must still compute fresh
  // rather than reuse empty data. ----
  {
    const { sandbox, calls } = buildSandbox({ weekHours: {} });
    const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
    await sandbox._buildHoursReportForDates(dates);
    check('an empty weekHours global still falls through to live computation', calls.some(function (c) { return c[0] === '_computeHoursForDateRange'; }), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
