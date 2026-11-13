// Hours-week-nav fix.
//
// Tom (Hours tab): tapping the week Back/Forward buttons was buggy --
// tap Back and nothing happens, tap Back again and it skips a week,
// several taps needed before it lands on the correct week.
//
// Root cause (confirmed by reading the code, not guessed):
// hoursWeekMove() updated hoursWeekOffset synchronously, but the label
// and the table only ever updated once the FULL load finished --
// several readiness awaits plus a Geotab/time_entries fetch.
// loadWeekHours()'s in-flight guard made this worse: a tap landing
// while a load was already running did NOT start a new load for its
// own offset -- it just returned the SAME stale promise. The one
// in-flight call would eventually read whatever hoursWeekOffset
// happened to be by the time it got there (after more taps had
// already changed it), landing on a week nobody individually tapped
// for -- exactly "tap Back, nothing happens; tap again, skips a week."
//
// Fix: hoursWeekMove() now updates the label/loading state instantly,
// synchronously, on every tap. loadWeekHours() still never runs two
// overlapping loads, but a tap landing mid-flight is never dropped --
// once the current load finishes, if hoursWeekOffset has moved on, it
// reruns immediately, converging on the correct final week every time.
//
// This test extracts the REAL getWeekDates, _hoursWeekLabelText,
// hoursWeekMove, and the loadWeekHours/_weekHoursLoadInFlight wrapper
// straight out of index.html. _loadWeekHoursInner itself (the heavy
// Geotab/time_entries fetch) is replaced by a small controllable mock
// -- its own arithmetic is covered elsewhere (resolve-employee-day-
// hours-equivalence, loadweekhours-vehicle-swap-attribution); this
// file's job is proving the NAVIGATION/SEQUENCING contract: every tap
// counts exactly once, slow loads never drop or misorder a tap, and
// the label always matches whatever actually got rendered.
//
// Run with: node tests/hours-week-nav.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (arguments.length === 1) { // boolean form
    if (actual) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); }
    return;
  }
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker (' + label + '): ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker after start (' + label + '): ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}

const getWeekDatesSrc = extract('function getWeekDates(offset) {', '\n\n// Hours-week-nav fix: the one shared label-text formula', 'getWeekDates');
const labelTextSrc = extract('function _hoursWeekLabelText(offset, days) {', '\n\n// Hours-week-nav fix: the label and a loading placeholder', '_hoursWeekLabelText');
const hoursWeekMoveSrc = extract('function hoursWeekMove(dir) {', '\n\n// PR #109 Item 3', 'hoursWeekMove');
const loadWeekHoursWrapperSrc = extract('var _weekHoursLoadInFlight = false;', '\nasync function _loadWeekHoursInner()', 'loadWeekHours wrapper');

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

// Builds a fresh sandbox with a CONTROLLABLE _loadWeekHoursInner mock:
// each call captures the offset it's attempting (exactly like the real
// function does, as its very first act) and does not resolve until the
// test explicitly releases it via the returned `release` function,
// letting tests simulate slow loads and out-of-order completions. Once
// released, it writes the label and a "data" marker into the DOM
// stubs, exactly what a real render would leave behind, so a test can
// assert the label and the data always agree on the same week.
function buildSandbox(opts) {
  opts = opts || {};
  const nodes = {
    'hours-week-label': { textContent: '' },
    'hours-table': { innerHTML: '' },
  };
  const pending = []; // { offset, release }
  const attempts = []; // every offset _loadWeekHoursInner was called for, in order
  const renders = []; // every offset that actually completed a render, in order

  const sandbox = {
    console,
    document: { getElementById: function (id) { return nodes[id]; } },
    hoursWeekOffset: 0,
    _weekHoursLastAttemptedOffset: null,
    getWeekDates: null, // filled in below once extracted
    _pentaPayWeekStartDay: function () { return opts.payWeekStartDay || 'monday'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(getWeekDatesSrc, sandbox);
  vm.runInContext(labelTextSrc, sandbox);
  vm.runInContext(hoursWeekMoveSrc, sandbox);

  sandbox._loadWeekHoursInner = function () {
    const myOffset = sandbox.hoursWeekOffset;
    sandbox._weekHoursLastAttemptedOffset = myOffset;
    attempts.push(myOffset);
    return new Promise(function (resolve) {
      const entry = {
        offset: myOffset,
        release: function () {
          nodes['hours-week-label'].textContent = sandbox._hoursWeekLabelText(myOffset);
          nodes['hours-table'].innerHTML = 'DATA FOR OFFSET ' + myOffset;
          renders.push(myOffset);
          resolve();
        },
      };
      pending.push(entry);
    });
  };
  vm.runInContext(loadWeekHoursWrapperSrc, sandbox);

  return {
    sandbox: sandbox,
    nodes: nodes,
    attempts: attempts,
    renders: renders,
    // Release the OLDEST still-pending load (FIFO -- simulates loads
    // finishing in the order they were started).
    releaseOldest: function () {
      const e = pending.shift();
      if (e) e.release();
      return e && e.offset;
    },
    pendingCount: function () { return pending.length; },
  };
}

async function main() {

// ======================================================================
// 1. Back 5 times lands exactly 5 weeks back -- each tap's load
//    completes before the next tap (no overlap), the simple case.
// ======================================================================
{
  const b = buildSandbox();
  for (let i = 0; i < 5; i++) {
    b.sandbox.hoursWeekMove(-1);
    await b.releaseOldest(); // let that tap's load finish before the next tap
    await tick();
  }
  check('offset is exactly -5 after 5 Back taps', b.sandbox.hoursWeekOffset, -5);
  check('exactly 5 loads were attempted, one per tap', b.attempts, [-1, -2, -3, -4, -5]);
  check('the label matches the final week', b.nodes['hours-week-label'].textContent, b.sandbox._hoursWeekLabelText(-5));
}

// ======================================================================
// 2. Back then Forward returns to exactly the same week (offset 0),
//    not off by one in either direction.
// ======================================================================
{
  const b = buildSandbox();
  b.sandbox.hoursWeekMove(-1);
  await b.releaseOldest(); await tick();
  b.sandbox.hoursWeekMove(-1);
  await b.releaseOldest(); await tick();
  check('offset is -2 after two Back taps', b.sandbox.hoursWeekOffset, -2);
  b.sandbox.hoursWeekMove(1);
  await b.releaseOldest(); await tick();
  b.sandbox.hoursWeekMove(1);
  await b.releaseOldest(); await tick();
  check('offset is back to 0 after two matching Forward taps', b.sandbox.hoursWeekOffset, 0);
  check('the label reads "This Week" again', b.nodes['hours-week-label'].textContent, 'This Week');
}

// ======================================================================
// 3. Rapid taps while a slow load is pending: the label updates
//    INSTANTLY on every tap (never "nothing happens"), no tap's offset
//    movement is ever dropped, and once everything settles, the table
//    data and the label both agree on the FINAL week -- never an
//    intermediate one, never a mismatch between the two.
// ======================================================================
{
  const b = buildSandbox();
  b.sandbox.hoursWeekMove(-1); // tap 1 -- starts a load for -1, which we leave pending (slow)
  check('tap 1: the label updates instantly, before the slow load resolves', b.nodes['hours-week-label'].textContent, 'Last Week');
  b.sandbox.hoursWeekMove(-1); // tap 2 lands WHILE tap 1's load is still pending
  check('tap 2: the label updates instantly again, even though a load is mid-flight', b.nodes['hours-week-label'].textContent, b.sandbox._hoursWeekLabelText(-2));
  b.sandbox.hoursWeekMove(-1); // tap 3, same situation
  check('tap 3: offset has moved a full 3 weeks back from 3 taps, none dropped', b.sandbox.hoursWeekOffset, -3);

  // Release every load that was started, in order, until nothing is
  // left pending -- mirrors the real do-while rerun loop draining.
  let guard = 0;
  while (b.pendingCount() > 0 && guard < 10) { b.releaseOldest(); await tick(); guard++; }

  check('the load eventually settles on the FINAL offset the user actually landed on (-3)', b.renders[b.renders.length - 1], -3);
  check('the label and the table data agree on the same week (both -3) -- never a mismatch', b.nodes['hours-week-label'].textContent, b.sandbox._hoursWeekLabelText(-3));
  check('the table shows that week\'s data, not a stale earlier one', b.nodes['hours-table'].innerHTML, 'DATA FOR OFFSET -3');
}

// ======================================================================
// 4. A stale slow response must not overwrite a newer week: load A
//    (started first, for week -1) is released AFTER load B (started
//    second, for week -2, from a second tap landing before A
//    finished) -- the wrapper's own rerun-on-change check must detect
//    that A's render is for an offset that's no longer current and
//    follow up with a correct run for -2, so -2 (the real final
//    answer) is what's left on screen, not -1.
// ======================================================================
{
  const b = buildSandbox();
  b.sandbox.hoursWeekMove(-1); // starts load A, for offset -1, left pending
  b.sandbox.hoursWeekMove(-1); // offset is now -2; loadWeekHours() call here just marks a rerun is needed (A is still in flight)

  check('both taps registered on the offset before either load resolved', b.sandbox.hoursWeekOffset, -2);

  // Only ONE load was ever actually started so far (the in-flight
  // guard never runs two Geotab/time_entries fetches concurrently).
  check('only one load is in flight at this point, not two overlapping ones', b.pendingCount(), 1);

  // Release load A (started for -1) -- it finishes LAST relative to
  // when it was requested, i.e. it's "late", but there is no SEPARATE
  // newer load racing it; the wrapper's rerun loop is what catches the
  // fact that hoursWeekOffset (-2) no longer matches what A rendered
  // (-1) and runs again.
  let guard = 0;
  while (b.pendingCount() > 0 && guard < 10) { b.releaseOldest(); await tick(); guard++; }

  check('the final rendered week is -2 (the real current one), not -1 (the stale one A was attempting)', b.renders[b.renders.length - 1], -2);
  check('the label was never left showing -1 after -2 was requested', b.nodes['hours-week-label'].textContent, b.sandbox._hoursWeekLabelText(-2));
  check('the table data matches -2 too -- label and data never disagree', b.nodes['hours-table'].innerHTML, 'DATA FOR OFFSET -2');
}

// ======================================================================
// 5. DST weeks: the week containing Nov 1 2026 (fall back) and the
//    week containing Mar 8 2026 (spring forward) both land on the
//    correct Monday with exactly 7 distinct, consecutive calendar
//    days -- getWeekDates uses calendar-safe setDate() arithmetic, not
//    raw 24h math, so it is unaffected by the clock change either way.
// ======================================================================
function getWeekDatesOnDate(nowStr, offset, payWeekStartDay) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) return new RealDate(nowStr); return new RealDate(...args); }
    static now() { return new RealDate(nowStr).getTime(); }
  }
  const sandbox = { console, _pentaPayWeekStartDay: function () { return payWeekStartDay || 'monday'; }, Date: FakeDate };
  vm.createContext(sandbox);
  vm.runInContext(getWeekDatesSrc, sandbox);
  return sandbox.getWeekDates(offset || 0);
}
function dk(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

{
  // Nov 1 2026 is a Sunday -- its week (Monday-start) is Oct 26 - Nov 1.
  const days = getWeekDatesOnDate('2026-10-29T12:00:00', 0);
  check('fall-back week: exactly 7 days', days.length, 7);
  check('fall-back week: starts on the right Monday (Oct 26)', dk(days[0]), '2026-10-26');
  check('fall-back week: ends on the right Sunday, the DST change day itself (Nov 1)', dk(days[6]), '2026-11-01');
  check('fall-back week: day 0 really is a Monday', days[0].getDay(), 1);
  const uniqueDays = new Set(days.map(dk));
  check('fall-back week: all 7 calendar dates are distinct (no day repeated or skipped)', uniqueDays.size, 7);
}
{
  // Mar 8 2026 is a Sunday -- its week (Monday-start) is Mar 2 - Mar 8.
  const days = getWeekDatesOnDate('2026-03-05T12:00:00', 0);
  check('spring-forward week: exactly 7 days', days.length, 7);
  check('spring-forward week: starts on the right Monday (Mar 2)', dk(days[0]), '2026-03-02');
  check('spring-forward week: ends on the right Sunday, the DST change day itself (Mar 8)', dk(days[6]), '2026-03-08');
  check('spring-forward week: day 0 really is a Monday', days[0].getDay(), 1);
  const uniqueDays = new Set(days.map(dk));
  check('spring-forward week: all 7 calendar dates are distinct (no day repeated or skipped)', uniqueDays.size, 7);
}
{
  // Same DST day again under a sunday-start business -- Nov 1 2026 is
  // itself a Sunday, so under a sunday-start convention it STARTS its
  // own week (Nov 1 - Nov 7), unlike the monday-start case above where
  // it ENDS one (Oct 26 - Nov 1).
  const days = getWeekDatesOnDate('2026-11-03T12:00:00', 0, 'sunday');
  check('fall-back week (sunday-start): exactly 7 days', days.length, 7);
  check('fall-back week (sunday-start): day 0 is a Sunday', days[0].getDay(), 0);
  check('fall-back week (sunday-start): starts Nov 1 (the DST change day itself), ends Nov 7', [dk(days[0]), dk(days[6])], ['2026-11-01', '2026-11-07']);
  const uniqueDays2 = new Set(days.map(dk));
  check('fall-back week (sunday-start): all 7 calendar dates are distinct', uniqueDays2.size, 7);
}

}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FAIL: uncaught error in test run:', e);
  process.exit(1);
});
