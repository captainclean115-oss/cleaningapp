// clearEmpDayHours ("Reset to GPS data") used to call a plain
// localStorage.removeItem() that could never fail. Now that
// clearEmpHours is a Supabase delete (migration 110 / PentaHourOverrides,
// see manual-hour-overrides-supabase.test.js), it can throw -- network,
// RLS -- so it needs the same isolated try/catch saveEmpDayHours already
// has (PR #169): an accurate "could not reset" message when nothing
// changed, distinct from a failure in the post-clear refresh step.
//
// Run with: node tests/clear-emp-day-hours-error-handling.test.js

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

const startMarker = 'async function clearEmpDayHours(empId, empName, dk) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find clearEmpDayHours()'); process.exit(1); }
const endMarker = '\n\nfunction formatHrs(';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find clearEmpDayHours end boundary'); process.exit(1); }
const fnSource = src.slice(startIdx, endIdx);

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const alerts = [];
  const els = { 'emp-hours-overlay': { removed: false, remove: function () { this.removed = true; } } };
  const sandbox = {
    console,
    document: { getElementById: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; } },
    alert: function (msg) { alerts.push(msg); },
    clearEmpHours: function (empId, dk) {
      calls.push(['clearEmpHours', empId, dk]);
      if (opts.clearThrows) return Promise.reject(new Error('permission denied for table manual_hour_overrides'));
      return Promise.resolve();
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
  // Happy path: clear succeeds, overlay closes, audit log + refresh run.
  {
    const { sandbox, els, calls, alerts } = buildSandbox();
    await sandbox.clearEmpDayHours('emp-1', 'Test Emp', '2026-08-31');
    check('clearEmpHours is called with the right employee/date', calls[0], ['clearEmpHours', 'emp-1', '2026-08-31']);
    check('overlay is removed on success', els['emp-hours-overlay'].removed, true);
    check('logPendingUpdate runs (audit trail)', calls.some(c => c[0] === 'logPendingUpdate'), true);
    check('loadWeekHours runs to refresh', calls.some(c => c[0] === 'loadWeekHours'), true);
    check('no alert on a clean successful clear', alerts.length, 0);
  }

  // The clear itself fails (e.g. RLS denial) -- nothing else should run,
  // and the message must say nothing changed, not "cleared."
  {
    const { sandbox, els, calls, alerts } = buildSandbox({ clearThrows: true });
    await sandbox.clearEmpDayHours('emp-1', 'Test Emp', '2026-08-31');
    check('the overlay is NOT closed when the clear itself fails', els['emp-hours-overlay'].removed, false);
    check('logPendingUpdate never runs -- nothing to log, the clear did not happen', calls.some(c => c[0] === 'logPendingUpdate'), false);
    check('loadWeekHours never runs either', calls.some(c => c[0] === 'loadWeekHours'), false);
    check('an accurate "could not reset" message is shown', alerts.some(a => /could not reset/i.test(a)), true);
    check('the message does not claim anything was cleared', alerts.some(a => /was cleared/i.test(a)), false);
  }

  // The clear succeeds but the post-clear refresh fails -- must say the
  // override WAS cleared (it was), only the refresh failed.
  {
    const { sandbox, els, calls, alerts } = buildSandbox({ loadWeekHoursRejects: true });
    await sandbox.clearEmpDayHours('emp-1', 'Test Emp', '2026-08-31');
    check('the clear itself still ran', calls.some(c => c[0] === 'clearEmpHours'), true);
    check('the overlay still closes (the clear genuinely worked)', els['emp-hours-overlay'].removed, true);
    check('the message correctly says the override WAS cleared, only refresh failed', alerts.some(a => /was cleared, but refreshing/i.test(a)), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
