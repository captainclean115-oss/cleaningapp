// Bug report: "Save button doesn't always work when editing hours...
// Click Save, nothing happens (button dead) OR button responds but
// change doesn't stick... intermittent."
//
// saveEmpDayHours() had NO error handling at all, and re-rendered via a
// bare renderHoursTable() call instead of the safer loadWeekHours()
// pattern its sibling clearEmpDayHours() was already fixed to use for
// exactly this reason (PR #119/#134's own comment there): a throw
// ANYWHERE in renderHoursTable's render pass -- not necessarily on THIS
// employee's own row, any OTHER employee's malformed data can trigger it
// too -- silently aborted the whole re-render. Depending on exactly
// where a throw landed, the save could look like "nothing happens" (a
// throw or missing DOM element before the overlay closes) or "responded
// but didn't stick" (a throw after) -- explaining the intermittent,
// hard-to-pin-down nature of both reported symptoms: it depended on
// which OTHER employee's data was in the table at the time, not on
// anything about the specific save being made.
//
// Fix: split into a save step and a refresh step, each in its own
// try/catch with an accurate, distinct message -- "could not save,
// nothing changed" only when nothing was actually written yet, "saved
// but the refresh failed" only when the write itself is already
// confirmed to have succeeded -- and switched the refresh to
// loadWeekHours() (same fix clearEmpDayHours already has).
//
// Run with: node tests/save-emp-day-hours-error-handling.test.js

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

const startMarker = 'async function saveEmpDayHours(empId, empName, dk) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find saveEmpDayHours()'); process.exit(1); }
const endMarker = '\n\nasync function clearEmpDayHours(';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find saveEmpDayHours end boundary'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx);

function buildSandbox(opts) {
  opts = opts || {};
  const els = opts.formMissing ? {} : {
    'emp-hr-start': { value: opts.start || '09:00' },
    'emp-hr-end': { value: opts.end || '17:00' },
    'emp-hr-lunch': { value: String(opts.lunch != null ? opts.lunch : 30) },
    'emp-hr-team': { value: 'B1' },
    'emp-hours-overlay': { removed: false, remove: function () { this.removed = true; } },
  };
  const calls = [];
  const alerts = [];
  const sandbox = {
    console,
    document: { getElementById: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; } },
    alert: function (msg) { alerts.push(msg); },
    calcHoursFromTimes: function (s, e, l) { return 7.5; },
    getEmpTasks: function () {
      if (opts.getEmpTasksThrows) throw new Error('corrupted task JSON');
      return [];
    },
    saveEmpHours: function (empId, dk, data) {
      calls.push(['saveEmpHours', empId, dk, data]);
      if (opts.saveEmpHoursThrows) throw new Error('localStorage quota exceeded');
    },
    logPendingUpdate: function (a, b) { calls.push(['logPendingUpdate', a, b]); },
    loadWeekHours: function () {
      calls.push(['loadWeekHours']);
      if (opts.loadWeekHoursRejects) return Promise.reject(new Error('geotab-call timed out'));
      return Promise.resolve();
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, els, calls, alerts };
}

async function main() {
  // Happy path: everything succeeds.
  {
    const { sandbox, els, calls, alerts } = buildSandbox();
    await sandbox.saveEmpDayHours('emp-1', 'Test Emp', '2026-09-10');
    check('saveEmpHours is called with the form values', calls[0], ['saveEmpHours', 'emp-1', '2026-09-10', { start: '09:00', end: '17:00', lunch: 30, hours: 7.5, team: 'B1' }]);
    check('logPendingUpdate is called (audit trail)', calls.some(c => c[0] === 'logPendingUpdate'), true);
    check('overlay is removed on success', els['emp-hours-overlay'].removed, true);
    check('loadWeekHours is called (not a bare renderHoursTable)', calls.some(c => c[0] === 'loadWeekHours'), true);
    check('no alert on a clean successful save', alerts.length, 0);
  }

  // The edit form is gone (overlay already closed some other way) --
  // must not throw, must not call saveEmpHours, must tell the user.
  {
    const { sandbox, calls, alerts } = buildSandbox({ formMissing: true });
    await sandbox.saveEmpDayHours('emp-1', 'Test Emp', '2026-09-10');
    check('saveEmpHours is never called when the form is gone', calls.some(c => c[0] === 'saveEmpHours'), false);
    check('a clear "form no longer open" message is shown', alerts.some(a => /no longer open/i.test(a)), true);
  }

  // The save step itself throws (e.g. corrupted existing task JSON read
  // before the write) -- nothing was persisted, message must say so,
  // and must NOT claim "saved".
  {
    const { sandbox, calls, alerts } = buildSandbox({ getEmpTasksThrows: true });
    await sandbox.saveEmpDayHours('emp-1', 'Test Emp', '2026-09-10');
    check('saveEmpHours is never reached if an earlier step throws', calls.some(c => c[0] === 'saveEmpHours'), false);
    check('logPendingUpdate/loadWeekHours never run either -- nothing claims success', calls.length, 0);
    check('the message says nothing was changed (accurate -- save never happened)', alerts.some(a => /nothing was changed/i.test(a)), true);
    check('the message does NOT falsely say the hours were saved', alerts.some(a => /hours were saved/i.test(a)), false);
  }

  // saveEmpHours itself throws (e.g. localStorage write failure) --
  // same accurate "not saved" contract.
  {
    const { sandbox, calls, alerts } = buildSandbox({ saveEmpHoursThrows: true });
    await sandbox.saveEmpDayHours('emp-1', 'Test Emp', '2026-09-10');
    check('logPendingUpdate does not run if the save call itself throws', calls.some(c => c[0] === 'logPendingUpdate'), false);
    check('an accurate "could not save" message is shown', alerts.some(a => /could not save/i.test(a)), true);
  }

  // The save succeeds, but the post-save refresh (loadWeekHours, standing
  // in for the old bare renderHoursTable() call) fails -- THIS is the
  // "responded but change doesn't stick" report. Must say the save
  // itself DID succeed (it did), unlike the old undifferentiated message.
  {
    const { sandbox, els, calls, alerts } = buildSandbox({ loadWeekHoursRejects: true });
    await sandbox.saveEmpDayHours('emp-1', 'Test Emp', '2026-09-10');
    check('saveEmpHours still ran and succeeded', calls.some(c => c[0] === 'saveEmpHours'), true);
    check('the overlay still closes (the save genuinely worked)', els['emp-hours-overlay'].removed, true);
    check('the message correctly says the hours WERE saved, only the refresh failed', alerts.some(a => /hours were saved, but refreshing/i.test(a)), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
