// Tom: "Add 'Last week' option to the Live tab GPS date filter... Last
// week = the complete pay week that ended most recently." Later
// extended: the week-start day (Sunday vs Monday) is a per-business
// setting (businesses.pay_week_start_day, migration 111), not
// hardcoded -- Manna's is Monday-Sunday, confirmed with Tom, but a
// future tenant may run Sunday-Saturday.
//
// _computeLastPayWeekRange(tz, startDay) must:
//  - return the most recently COMPLETED week for whichever startDay
//    ('sunday' or 'monday') is passed in
//  - evaluate "today" in the BUSINESS's timezone, not the viewer's
//    browser timezone
//  - produce real UTC instants for the week's start/end, correct across
//    a DST transition
//
// This test extracts the real _bizTodayParts/_bizWallClockToUtc/
// _computeLastPayWeekRange functions verbatim and injects a fixed "now"
// into the sandbox's Date (rather than depending on the real system
// clock), so every scenario below is deterministic regardless of when
// this test actually runs.
//
// Run with: node tests/gps-last-week-pay-period.test.js

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

const startMarker = 'function _bizTodayParts(';
const endMarker = '\n\n// ─────────────────────────────────────────';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find _bizTodayParts()'); process.exit(1); }
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find the end boundary'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx);

// Real system Date, preserved so the mock class below can still
// construct/format real instants -- only `new Date()` (no args) is
// overridden to return the fixed "now" each scenario asks for.
const RealDate = Date;
function makeFixedDateClass(fixedNowMs) {
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedNowMs);
      else super(...args);
    }
  }
  return FixedDate;
}

// Compute the real UTC instant for HH:MM:SS on a given date AS OBSERVED
// in tz, using the real Intl API directly (independent re-derivation,
// NOT calling the code under test) -- used only to build expected
// values for assertions below.
function expectedUtcFor(y, m, d, hh, mm, ss, tz) {
  var guess = new RealDate(RealDate.UTC(y, m - 1, d, hh, mm, ss));
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  var parts = fmt.formatToParts(guess).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
  var gh = parseInt(parts.hour, 10); if (gh === 24) gh = 0;
  var asIfUtc = RealDate.UTC(+parts.year, +parts.month - 1, +parts.day, gh, +parts.minute, +parts.second);
  var drift = asIfUtc - guess.getTime();
  return new RealDate(guess.getTime() - drift);
}

function runAt(fixedIsoInstant, tz, startDay) {
  const sandbox = { console, Intl, Date: makeFixedDateClass(new RealDate(fixedIsoInstant).getTime()) };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox._computeLastPayWeekRange(tz, startDay);
}

// ---- Basic case: today is a Wednesday, business TZ = Eastern, Monday-
// start (Manna's real setting). This week's Monday is Sep 7; last week
// is Aug 31 (Mon) - Sep 6 (Sun). ----
{
  const r = runAt('2026-09-09T15:00:00.000Z', 'America/New_York', 'monday');
  check('most recently completed week is Mon Aug 31 - Sun Sep 6', { s: r.startYmd, e: r.endYmd }, { s: '2026-08-31', e: '2026-09-06' });
  check('fromDate is exactly midnight Monday in business-local time (EDT, UTC-4)', r.fromDate.toISOString(), '2026-08-31T04:00:00.000Z');
  check('toDate is exactly 23:59:59 Sunday in business-local time (EDT, UTC-4)', r.toDate.toISOString(), '2026-09-07T03:59:59.000Z');
  check('back-compat mondayYmd/sundayYmd aliases still work for existing callers', { m: r.mondayYmd, s: r.sundayYmd }, { m: '2026-08-31', s: '2026-09-06' });
}

// ---- Same fixed instant, but a SUNDAY-start business (a hypothetical
// future tenant). The most recently completed Sun-Sat week is
// different from the Monday-start result above. ----
{
  const r = runAt('2026-09-09T15:00:00.000Z', 'America/New_York', 'sunday');
  check('sunday-start business resolves a DIFFERENT week than monday-start (Aug 30 - Sep 5)', { s: r.startYmd, e: r.endYmd }, { s: '2026-08-30', e: '2026-09-05' });
}

// ---- Missing/invalid startDay falls back to monday (matches the DB
// column's own DEFAULT) rather than throwing or silently picking
// something else. ----
{
  const r = runAt('2026-09-09T15:00:00.000Z', 'America/New_York', undefined);
  check('an unset startDay falls back to monday-start', { s: r.startYmd, e: r.endYmd }, { s: '2026-08-31', e: '2026-09-06' });
}

// ---- Edge case: today IS the week's start day -- "last week" must be
// the 7 days immediately prior, not the week that just started. Tested
// for both conventions. ----
{
  // 2026-08-31 12:00 UTC = 8:00 AM EDT, a Monday.
  const r = runAt('2026-08-31T12:00:00.000Z', 'America/New_York', 'monday');
  check('monday-start: when today is Monday, last week is the PRIOR Mon-Sun', { s: r.startYmd, e: r.endYmd }, { s: '2026-08-24', e: '2026-08-30' });
}
{
  // 2026-08-30 12:00 UTC = 8:00 AM EDT, a Sunday.
  const r = runAt('2026-08-30T12:00:00.000Z', 'America/New_York', 'sunday');
  check('sunday-start: when today is Sunday, last week is the PRIOR Sun-Sat', { s: r.startYmd, e: r.endYmd }, { s: '2026-08-23', e: '2026-08-29' });
}

// ---- The whole reason this feature exists: rolling-7-days is NOT the
// same as last pay week. Confirm they diverge for a mid-week "now". ----
{
  const r = runAt('2026-09-09T15:00:00.000Z', 'America/New_York', 'monday'); // Wednesday
  const rollingFrom = new Date(new Date('2026-09-09T15:00:00.000Z').getTime() - 7 * 86400000);
  check('last-week start is NOT the same as "7 days ago from now" (proves this is a fixed calendar week, not a rolling window)', r.fromDate.toISOString() === rollingFrom.toISOString(), false);
}

// ---- Cross-timezone: viewer's browser timezone must NOT affect which
// week is computed -- only the business timezone parameter matters. ----
{
  const r = runAt('2026-09-09T15:00:00.000Z', 'America/Los_Angeles', 'monday'); // 8:00 AM PDT, still Wednesday
  check('a different business timezone still resolves the correct week when the wall-clock day agrees', { s: r.startYmd, e: r.endYmd }, { s: '2026-08-31', e: '2026-09-06' });
}

// ---- DST transition: the pay week spanning the "fall back" transition
// (2026-11-01 in the US) must still produce the correct wall-clock
// boundaries in each half of the week (EDT before, EST after). ----
{
  const r = runAt('2026-11-04T15:00:00.000Z', 'America/New_York', 'monday'); // Wednesday, Nov 4 (already in EST)
  check('last week is Oct 26 - Nov 1 (the DST-transition week)', { s: r.startYmd, e: r.endYmd }, { s: '2026-10-26', e: '2026-11-01' });
  check('fromDate (Mon Oct 26 00:00 local) uses the EDT offset still in effect', r.fromDate.toISOString(), expectedUtcFor(2026, 10, 26, 0, 0, 0, 'America/New_York').toISOString());
  check('toDate (Sun Nov 1 23:59:59 local) uses the EST offset after the fall-back', r.toDate.toISOString(), expectedUtcFor(2026, 11, 1, 23, 59, 59, 'America/New_York').toISOString());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
