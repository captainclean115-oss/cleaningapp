// Salaried Admin/Office (follow-up to migration 113) -- Export Hours
// Report's Admin/Office section, now inside _buildHoursReportFromData's
// simplified Name+Hours output (payroll report simplification).
//
// The old low-level harness here wrapped the admin block's exact
// literal source text with synthetic local variables (textLines,
// csvRows, grandHours, empsSeen) matching the OLD per-day-row
// structure. That structure is gone -- the admin section now just
// accumulates a weekly total per employee into the shared `rows` list
// the rest of the report sorts and displays. Updated to drive the REAL
// _buildHoursReportFromData end to end (same pattern as
// hours-report-employee-fragmentation.test.js) and check its actual
// output instead of reaching into removed internals.
//
// Run with: node tests/salaried-admin-export-report-section.test.js

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

const resolveSrc = extract('function _hrsFmtHrs(h) {', 'function _hrCsvField(s) {', 'resolveEmployeeDayHours');
const csvFieldSrc = extract('function _hrCsvField(s) {', 'function _hoursReportDefaultRange() {', '_hrCsvField');
const fnSrc = extract('function _hrSplitName(emp) {', '\n\nfunction _hrDownloadCsv(', '_buildHoursReportFromData');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [];
  const overrides = opts.overrides || {};
  const offDays = opts.offDays || {};
  const sandbox = {
    console,
    window: { PentaTenant: null },
    dateKey: (d) => (typeof d === 'string' ? d : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'))),
    getUnifiedRoster: () => roster,
    getEmployeeTeam: () => null, // these fixtures are all Admin/Office -- never a field team
    isSalariedAdmin: (emp) => emp && emp.work_type === 'admin' && emp.pay_type === 'salary',
    _employeeExcludedAsOf: (emp, dateStr) => !!(emp && emp.status === 'terminated' && emp.terminated_at && dateStr >= emp.terminated_at),
    _adminEmpDayOff: (empId, dk) => offDays[empId + '|' + dk] || null,
    getEmpHours: opts.getEmpHours || ((empId, dk) => (overrides[empId] && overrides[empId][dk]) || null),
  };
  vm.createContext(sandbox);
  vm.runInContext(resolveSrc, sandbox);
  vm.runInContext(csvFieldSrc, sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox;
}

function main() {
  // ---- Salaried employee: never appears, contributes nothing ----
  {
    const roster = [{ id: 'e-linda', name: 'Linda', work_type: 'admin', pay_type: 'salary' }];
    const sandbox = buildSandbox({ roster });
    const rep = sandbox._buildHoursReportFromData(DATES, {}, [], {});

    check('Linda never appears (empsSeen 0, no rows at all)', rep.empsSeen, 0);
    check('no "Linda" anywhere in the text', rep.text.indexOf('Linda') === -1, true);
    check('no "Linda" anywhere in the CSV', rep.csv.indexOf('Linda') === -1, true);
    check('she contributes 0 to grandHours', rep.grandHours, 0);
  }

  // ---- Hourly admin (not salaried): unaffected, one row with her real hours ----
  {
    const roster = [{ id: 'e-pat', name: 'Pat Palmer', work_type: 'admin', pay_type: 'hourly' }];
    const overrides = { 'e-pat': { '2026-10-06': { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 } } };
    const sandbox = buildSandbox({ roster, overrides });
    const rep = sandbox._buildHoursReportFromData(DATES, {}, [], {});

    check('Pat gets exactly one row', rep.empsSeen, 1);
    check('Pat\'s real 7.50h shows in the report', rep.text.indexOf('7.50') !== -1, true);
    check('the row is never labeled Salaried', /Salaried/.test(rep.text), false);
  }

  // ---- Mixed: salaried contributes 0, hourly contributes real hours, to the SAME grand total ----
  {
    const roster = [
      { id: 'e-linda', name: 'Linda', work_type: 'admin', pay_type: 'salary' },
      { id: 'e-pat', name: 'Pat Palmer', work_type: 'admin', pay_type: 'hourly' },
    ];
    const overrides = { 'e-pat': { '2026-10-06': { start: '09:00', end: '14:00', lunch: 0, hours: 5 } } };
    const sandbox = buildSandbox({ roster, overrides });
    const rep = sandbox._buildHoursReportFromData(DATES, {}, [], {});

    check('only ONE row total -- Linda never gets a row even though she\'s on the roster', rep.empsSeen, 1);
    check('grandHours is exactly Pat\'s 5h -- Linda added nothing', rep.grandHours, 5);
  }

  // ---- A throwing getEmpHours degrades to a visible error note, doesn't crash the whole report ----
  {
    const roster = [{ id: 'e-pat', name: 'Pat Palmer', work_type: 'admin', pay_type: 'hourly' }];
    const sandbox = buildSandbox({ roster, getEmpHours: () => { throw new Error('synthetic export failure'); } });
    const rep = sandbox._buildHoursReportFromData(DATES, {}, [], {});
    check('a thrown error produces a visible failure note in the text report (no silent failure)', /ADMIN\/OFFICE SECTION FAILED TO LOAD/.test(rep.text), true);
    check('the real error message is surfaced', rep.text.indexOf('synthetic export failure') !== -1, true);
    check('the failure note never leaks into the CSV (still clean two-column data)', rep.csv.indexOf('FAILED') === -1, true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
