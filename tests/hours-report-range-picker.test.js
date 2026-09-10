// Tom: "Export Hours Report doesn't respect the week Tom is currently
// viewing on the Live tab." Diagnosis confirmed: showHoursReport() fired
// _buildHoursReport(0) (hardcoded to the Hours tab's own current week)
// immediately, with no picker at all -- completely ignoring the Live
// tab's own GPS filter state (last week/custom/rolling).
//
// _hoursReportDefaultRange() must read the Live tab's actual GPS filter
// state (window._gpsActivityWindowMode + the range globals the GPS
// filter itself sets) and fall back to the Hours tab's own week only
// when there's no Live-tab state yet. Extracts the REAL function
// verbatim and drives it with different window states.
//
// Run with: node tests/hours-report-range-picker.test.js

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

// Real dependencies: the actual pay-week helpers this reuses.
const bizTodayPartsSrc = extract('function _bizTodayParts(', '\n\n// Constructs the actual UTC instant');
const bizWallClockSrc = extract('function _bizWallClockToUtc(', '\n\n// Returns { fromDate, toDate,');
const lastPayWeekSrc = extract('function _computeLastPayWeekRange(', '\n\n\n// ─────────────────────────────────────────');
const defaultRangeSrc = extract('function _hoursReportDefaultRange() {', '\n\nfunction openHoursReportPicker()');
const quickSelectSrc = extract('function _hoursReportQuickSelect(', '\n\nasync function confirmHoursReportExport()');

function buildSandbox(opts) {
  opts = opts || {};
  const sandbox = {
    console, Intl,
    window: opts.window || {},
    document: opts.document || { getElementById: function () { return null; } },
    hoursWeekOffset: opts.hoursWeekOffset || 0,
    dateKey: function (d) { var dt = (d instanceof Date) ? d : new Date(d); return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); },
    getWeekDates: opts.getWeekDates || function () { return [new Date('2026-08-31T00:00:00'), new Date('2026-09-04T00:00:00')]; },
    getGPSDate: opts.getGPSDate || function () { return new Date('2026-09-05T00:00:00'); },
    _pentaBusinessTimezone: function () { return 'America/New_York'; },
    _pentaPayWeekStartDay: function () { return opts.payWeekStartDay || 'monday'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(bizTodayPartsSrc, sandbox);
  vm.runInContext(bizWallClockSrc, sandbox);
  vm.runInContext(lastPayWeekSrc, sandbox);
  vm.runInContext(defaultRangeSrc, sandbox);
  vm.runInContext(quickSelectSrc, sandbox);
  return sandbox;
}

function main() {
  // ---- Live tab is on "Last week" -- default must match that exact range ----
  {
    const sandbox = buildSandbox({
      window: { _gpsActivityWindowMode: 'lastweek', _gpsLastWeekRange: { startYmd: '2026-08-24', endYmd: '2026-08-30' } },
    });
    check('defaults to the GPS filter\'s current "last week" range', sandbox._hoursReportDefaultRange(), { from: '2026-08-24', to: '2026-08-30' });
  }

  // ---- Live tab is on "Custom range" -- default must match the picked dates ----
  {
    const sandbox = buildSandbox({
      window: { _gpsActivityWindowMode: 'custom', _gpsCustomRange: { from: '2026-07-01', to: '2026-07-15' } },
    });
    check('defaults to the GPS filter\'s current custom range', sandbox._hoursReportDefaultRange(), { from: '2026-07-01', to: '2026-07-15' });
  }

  // ---- Live tab is on "Last 7 days" (rolling) ----
  {
    const sandbox = buildSandbox({ window: { _gpsActivityWindowMode: '7d' } });
    // "now" for _bizTodayParts is the real system clock here (not mocked)
    // -- just confirm the range is exactly 7 days ending today, business tz.
    const r = sandbox._hoursReportDefaultRange();
    const days = (new Date(r.to + 'T00:00:00') - new Date(r.from + 'T00:00:00')) / 86400000;
    check('a 7d rolling window default spans exactly 7 days', days, 6);
  }

  // ---- Live tab is on "Last 24 hours" -- default is the single GPS-picker date ----
  {
    const sandbox = buildSandbox({ window: { _gpsActivityWindowMode: '24h' }, getGPSDate: function () { return new Date('2026-09-05T00:00:00'); } });
    check('24h mode defaults to the single GPS date picker day', sandbox._hoursReportDefaultRange(), { from: '2026-09-05', to: '2026-09-05' });
  }

  // ---- No Live-tab GPS state at all -- fall back to the Hours tab's own week ----
  {
    const sandbox = buildSandbox({
      window: {}, // _gpsActivityWindowMode never set (Live tab never opened this session)
      getWeekDates: function () { return [new Date('2026-09-07T00:00:00'), new Date('2026-09-08T00:00:00'), new Date('2026-09-09T00:00:00'), new Date('2026-09-10T00:00:00'), new Date('2026-09-11T00:00:00')]; },
    });
    check('falls back to the Hours tab week when the Live tab has no state', sandbox._hoursReportDefaultRange(), { from: '2026-09-07', to: '2026-09-11' });
  }

  // ---- Quick-select "Last week" respects the pay-week setting ----
  {
    let fromVal = '', toVal = '';
    const fakeFrom = { get value() { return fromVal; }, set value(v) { fromVal = v; } };
    const fakeTo = { get value() { return toVal; }, set value(v) { toVal = v; } };
    const sandbox = buildSandbox({
      payWeekStartDay: 'monday',
      document: { getElementById: function (id) { return id === 'hours-report-from' ? fakeFrom : id === 'hours-report-to' ? fakeTo : null; } },
    });
    // Monkey-patch _computeLastPayWeekRange call context to use a fixed "now" via a real call (uses real system clock; just check the shape/relationship instead of an exact date since the real clock varies).
    sandbox._hoursReportQuickSelect('lastweek');
    check('quick-select last-week populates both from/to date inputs', fromVal.length === 10 && toVal.length === 10, true);
    check('the picked range is exactly 7 days (a full week)', (new Date(toVal + 'T00:00:00') - new Date(fromVal + 'T00:00:00')) / 86400000, 6);
  }

  // ---- Quick-select "This week" also respects the pay-week setting (sunday-start business) ----
  {
    let fromVal = '', toVal = '';
    const fakeFrom = { get value() { return fromVal; }, set value(v) { fromVal = v; } };
    const fakeTo = { get value() { return toVal; }, set value(v) { toVal = v; } };
    const sandbox = buildSandbox({
      payWeekStartDay: 'sunday',
      document: { getElementById: function (id) { return id === 'hours-report-from' ? fakeFrom : id === 'hours-report-to' ? fakeTo : null; } },
    });
    sandbox._hoursReportQuickSelect('thisweek');
    const fromDow = new Date(fromVal + 'T00:00:00').getUTCDay();
    // Constructed from Y-M-D via "T00:00:00" (browser-local) -- just
    // confirm the resulting weekday is Sunday(0) per the sunday setting.
    check('this-week start lands on Sunday for a sunday-start business', new Date(fromVal + 'T12:00:00Z').getUTCDay(), 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
