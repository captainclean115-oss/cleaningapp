// Published Hours feature -- unit tests for _republishAfterHoursEdit(),
// the wiring that makes a manager edit (override save, Team Hours
// modal, Claire's tools) actually reach the employee-facing publish
// hook. The hook itself lives at the tail of _loadWeekHoursInner (one
// debounced setTimeout call, covered implicitly here by observing
// loadWeekHours() got called for the correct week) -- this file proves
// _republishAfterHoursEdit realigns hoursWeekOffset to the EDITED date's
// own week, runs loadWeekHours() there, and restores whatever week the
// manager was actually looking at afterward, exactly like the portal's
// own temporary-realign pattern.
//
// Run with: node tests/republish-after-hours-edit.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed: could not find start marker (' + label + '): ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed: could not find end marker after start (' + label + '): ' + endMarker);
  return src.slice(s, e);
}

const republishSrc = extract(
  'function _weekOffsetForDate(dateStr) {',
  '\n\n// Manager-facing "Publish now" button',
  '_weekOffsetForDate + _republishAfterHoursEdit'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const loadCalls = [];
  const sandbox = {
    console: console,
    document: {
      getElementById: function (id) {
        if (id !== 'gps-view') return null;
        return { classList: { contains: function () { return !!opts.gpsViewActive; } } };
      },
    },
    hoursWeekOffset: opts.startingOffset != null ? opts.startingOffset : 0,
    getWeekDates: function (offset) {
      // Monday of "this week" fixed to 2026-08-17 for a deterministic
      // offset<->date mapping in this test.
      const base = new Date(2026, 7, 17);
      const mon = new Date(base);
      mon.setDate(base.getDate() + offset * 7);
      return [0, 1, 2, 3, 4].map(function (i) { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
    },
    loadWeekHours: function () {
      loadCalls.push(sandbox.hoursWeekOffset);
      return Promise.resolve();
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(republishSrc, sandbox);
  return { sandbox: sandbox, loadCalls: loadCalls };
}

(async function () {
  console.log('Testing extracted _republishAfterHoursEdit() from index.html\n');

  // Editing a date inside the week the manager is ALREADY viewing: one
  // loadWeekHours() call, offset unchanged throughout.
  {
    const { sandbox, loadCalls } = buildSandbox({ startingOffset: 0, gpsViewActive: true });
    await sandbox._republishAfterHoursEdit('2026-08-18'); // Tue, this week
    check('same-week edit: loadWeekHours() called exactly once', loadCalls.length, 1);
    check('same-week edit: called at offset 0 (the week actually being edited)', loadCalls[0], 0);
    check('same-week edit: hoursWeekOffset ends back at 0', sandbox.hoursWeekOffset, 0);
  }

  // Editing a date in a DIFFERENT week than the manager is currently
  // viewing, with the Live tab active: realigns, publishes, then
  // restores AND reloads the manager's own real week (two calls total).
  {
    const { sandbox, loadCalls } = buildSandbox({ startingOffset: 0, gpsViewActive: true });
    await sandbox._republishAfterHoursEdit('2026-08-03'); // two weeks before "this week"
    check('cross-week edit while Live tab active: loadWeekHours() called twice (edited week, then restore)', loadCalls.length, 2);
    check('cross-week edit: first call is for the EDITED week (offset -2)', loadCalls[0], -2);
    check('cross-week edit: second call restores the manager\'s own week (offset 0)', loadCalls[1], 0);
    check('hoursWeekOffset ends back at the manager\'s real week', sandbox.hoursWeekOffset, 0);
  }

  // Same cross-week edit, but the Live tab is NOT the active view: only
  // publishes the edited week -- no need to restore a view nobody's
  // looking at, but hoursWeekOffset itself is still restored (so a
  // concurrent "Preview as employee" in the same tab never sees it stuck
  // on the wrong week).
  {
    const { sandbox, loadCalls } = buildSandbox({ startingOffset: 0, gpsViewActive: false });
    await sandbox._republishAfterHoursEdit('2026-08-03');
    check('cross-week edit, Live tab NOT active: loadWeekHours() called only once (no pointless restore-reload)', loadCalls.length, 1);
    check('hoursWeekOffset variable is still restored even though no reload happened', sandbox.hoursWeekOffset, 0);
  }

  // A Claire batch touching several dates in the SAME week collapses to
  // one loadWeekHours() call, not one per date.
  {
    const { sandbox, loadCalls } = buildSandbox({ startingOffset: 0, gpsViewActive: true });
    await sandbox._republishAfterHoursEdit(['2026-08-17', '2026-08-18', '2026-08-19']);
    check('batch touching one week: single loadWeekHours() call, not one per date', loadCalls.length, 1);
  }

  // A Claire batch spanning two distinct weeks does one call per week.
  {
    const { sandbox, loadCalls } = buildSandbox({ startingOffset: 0, gpsViewActive: false });
    await sandbox._republishAfterHoursEdit(['2026-08-17', '2026-08-03']);
    check('batch spanning two weeks: one loadWeekHours() call per distinct week', loadCalls.length, 2);
  }

  // A thrown loadWeekHours() must not propagate out -- a republish
  // failure is logged, not surfaced as an uncaught rejection that could
  // break the caller's own success path (saveEmpDayHours's alert, Claire's reply).
  {
    const { sandbox } = buildSandbox({ startingOffset: 0, gpsViewActive: true });
    sandbox.loadWeekHours = function () { return Promise.reject(new Error('simulated failure')); };
    let threw = false;
    try { await sandbox._republishAfterHoursEdit('2026-08-17'); } catch (e) { threw = true; }
    check('a republish failure is swallowed, never thrown back to the caller', threw, false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
