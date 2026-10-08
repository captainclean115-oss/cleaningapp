// Salaried Admin/Office (follow-up to migration 113) -- Export Hours
// Report's Admin/Office section (_buildHoursReportFromData).
//
// Extracts the REAL Admin/Office block and wraps it in a thin
// synthetic harness supplying exactly the locals it closes over
// (dates, textLines, csvRows, grandHours, empsSeen, SEP_THIN).
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

const blockSrc = extract(
  "  try {\n    var adminEmployees = getUnifiedRoster().filter(function (e) { return e.work_type === 'admin'; });",
  "\n\n  textLines.push('');",
  '_buildHoursReportFromData Admin/Office block'
);

const harnessSrc = `
function runAdminSection(dates) {
  var textLines = [];
  var csvRows = [];
  var grandHours = 0;
  var empsSeen = 0;
${blockSrc}
  return { textLines: textLines, csvRows: csvRows, grandHours: grandHours, empsSeen: empsSeen };
}
`;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
const SEP_THIN = '-'.repeat(43);

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [];
  const overrides = opts.overrides || {};
  const offDays = opts.offDays || {};
  const sandbox = {
    console,
    SEP_THIN,
    getUnifiedRoster: () => roster,
    isSalariedAdmin: (emp) => emp && emp.work_type === 'admin' && emp.pay_type === 'salary',
    _adminEmpDayOff: (empId, dk) => offDays[empId + '|' + dk] || null,
    getEmpHours: (empId, dk) => (overrides[empId] && overrides[empId][dk]) || null,
    _hrCsvField: (s) => (s == null ? '' : String(s)),
    _hrDecimalHoursText: (h) => (!h || h <= 0 ? '0h 0m' : h + 'h'),
    _hrTo24hr: (s) => s,
    _hrMinsToHHMM: (m) => (!m ? '00:00' : String(m)),
    _hrDecimalHoursToHHMM: (h) => (!h ? '00:00' : String(h)),
  };
  vm.createContext(sandbox);
  vm.runInContext(harnessSrc, sandbox);
  return sandbox;
}

function main() {
  // ---- Salaried employee: single summary line, no day rows, no CSV rows ----
  {
    const roster = [{ id: 'e-linda', name: 'Linda', work_type: 'admin', pay_type: 'salary' }];
    const sandbox = buildSandbox({ roster });
    const result = sandbox.runAdminSection(DATES);

    check('Linda is counted once (empsSeen)', result.empsSeen, 1);
    check('a single "no hours tracked" line appears', result.textLines.some((l) => /LINDA \(Admin, Salaried\) — no hours tracked/.test(l)), true);
    check('no day-by-day rows exist for her at all (only the one summary line)', result.textLines.filter((l) => l.indexOf('LINDA') === 0 || /^\s{2}[A-Za-z]{3} /.test(l)).length, 1);
    check('she contributes 0 to grandHours', result.grandHours, 0);
    check('no CSV rows are written for her', result.csvRows.filter((r) => r.indexOf('Linda') === 0).length, 0);
  }

  // ---- Hourly admin (not salaried): unaffected, full day rows + CSV ----
  {
    const roster = [{ id: 'e-pat', name: 'Pat', work_type: 'admin', pay_type: 'hourly' }];
    const overrides = { 'e-pat': { '2026-10-06': { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 } } };
    const sandbox = buildSandbox({ roster, overrides });
    const result = sandbox.runAdminSection(DATES);

    check('Pat gets 5 CSV rows (one per date, same as before this feature)', result.csvRows.filter((r) => r.indexOf('Pat') === 0).length, 5);
    check('Pat\'s real 7.5h contributes to grandHours', result.grandHours, 7.5);
    check('Pat is not labeled Salaried', result.textLines.some((l) => /Salaried/.test(l)), false);
  }

  // ---- Mixed: salaried contributes 0, hourly contributes real hours, to the SAME grand total ----
  {
    const roster = [
      { id: 'e-linda', name: 'Linda', work_type: 'admin', pay_type: 'salary' },
      { id: 'e-pat', name: 'Pat', work_type: 'admin', pay_type: 'hourly' },
    ];
    const overrides = { 'e-pat': { '2026-10-06': { start: '09:00', end: '14:00', lunch: 0, hours: 5 } } };
    const sandbox = buildSandbox({ roster, overrides });
    const result = sandbox.runAdminSection(DATES);

    check('empsSeen counts BOTH (2) -- Linda still appears in the report even with no hours', result.empsSeen, 2);
    check('grandHours is exactly Pat\'s 5h -- Linda added nothing', result.grandHours, 5);
  }

  // ---- A throwing getEmpHours degrades to a visible error note, doesn't crash the whole report ----
  {
    const roster = [{ id: 'e-pat', name: 'Pat', work_type: 'admin', pay_type: 'hourly' }];
    const sandbox = buildSandbox({ roster });
    sandbox.getEmpHours = () => { throw new Error('synthetic export failure'); };
    const result = sandbox.runAdminSection(DATES);
    check('a thrown error produces a visible failure note in the text report', result.textLines.some((l) => /ADMIN\/OFFICE SECTION FAILED TO LOAD/.test(l)), true);
    check('the real error message is surfaced', result.textLines.some((l) => /synthetic export failure/.test(l)), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
