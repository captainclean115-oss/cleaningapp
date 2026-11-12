// PR #186 -- Export Hours Report used to fragment a single employee's
// week across MULTIPLE per-team sections (one per team they touched
// that week), each showing only a PARTIAL subtotal, while the Live
// tab's Hours Worked widget (renderHoursTable) always shows an
// employee ONCE with one combined weekly total. Every single day's
// hours/start/end computation was already provably identical between
// the two paths (see project_gps_crossref_allornothing_gate/PR #179's
// verification) -- the divergence was purely in HOW _buildHoursReportFromData
// grouped/displayed an employee across a cross-team week.
//
// Confirmed live against real Manna data: Katia Mejia (default team B1,
// team_device override to S3 on one day that week) showed
// "KATIA MEJIA (B1) — 22h 47m" in one section and a separate,
// easy-to-miss "KATIA MEJIA (S3) — 6h 3m" section elsewhere in the same
// report -- the two together match the Live tab exactly, but read as a
// report, it looked like her total was 22h47m, a "6 hour" discrepancy
// that was actually just a missing second section.
//
// Payroll report simplification (Tom's request): the team-grouped
// display (and per-day/per-team CSV rows) this test used to check is
// GONE entirely now -- the report is two columns, Name and Hours, one
// row per employee, period. The underlying concern this test guards
// against is unchanged, though: an employee who worked more than one
// team in range must still appear exactly ONCE, with ONE total that
// correctly sums hours from EVERY team worked, never fragmented or
// silently dropped. Updated to assert that against the new shape,
// via resolveEmployeeDayHours -- the same real, shared function the
// Hours tab itself calls, extracted here instead of re-implemented.
//
// Run with: node tests/hours-report-employee-fragmentation.test.js

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

const resolveSrc = extract('function _hrsFmtHrs(h) {', 'function _hrCsvField(s) {');
const csvFieldSrc = extract('function _hrCsvField(s) {', 'function _hoursReportDefaultRange() {');
const fnSrc = extract('function _hrSplitName(emp) {', '\n\nfunction _hrDownloadCsv(');

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [];
  const assignments = opts.assignments || {}; // { 'date_empId': team }
  const overrides = opts.overrides || {}; // { 'empId_date': {...} }
  const sandbox = {
    console,
    window: { PentaTenant: null },
    dateKey: function (d) { return typeof d === 'string' ? d : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); },
    getUnifiedRoster: function () { return roster; },
    getEmployeeTeam: function (empId, dk) {
      var key = dk + '_' + empId;
      return Object.prototype.hasOwnProperty.call(assignments, key) ? assignments[key] : null;
    },
    getEmpHours: function (empId, dk) { return overrides[empId + '_' + dk] || null; },
    _employeeExcludedAsOf: function (emp, dateStr) {
      return !!(emp && emp.status === 'terminated' && emp.terminated_at && dateStr >= emp.terminated_at);
    },
    _adminEmpDayOff: function () { return null; },
    isSalariedAdmin: function () { return false; },
  };
  vm.createContext(sandbox);
  vm.runInContext(resolveSrc, sandbox);
  vm.runInContext(csvFieldSrc, sandbox);
  vm.runInContext(fnSrc, sandbox);
  return sandbox;
}

function main() {
  // ==== Real-shape replication: Katia Mejia, default B1, one day (Thu)
  // overridden to S3, no manual overrides -- pure team-GPS hours, same
  // per-day values as the real live-verified data. ====
  {
    const dates = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    const roster = [{ id: 'katia', uuid: 'katia-uuid', name: 'Katia Mejia', defaultTeam: 'B1' }];
    const assignments = {
      '2026-08-31_katia': null, // OFF
      '2026-09-01_katia': 'B1',
      '2026-09-02_katia': 'B1',
      '2026-09-03_katia': 'B1',
      '2026-09-04_katia': 'S3', // the cross-team day
    };
    const weekHoursData = {
      B1: { days: [0, 10.2, 5.663422777777778, 6.928087777777778, 0], starts: [null, '09:00', '09:08', '09:09', null], ends: [null, '19:25', '14:52', '16:08', null], lunch: [null, { duration: 13 }, { duration: 4 }, { duration: 3 }, null], total: 0 },
      S3: { days: [0, 0, 0, 0, 6.049166666666667], starts: [null, null, null, null, '09:02'], ends: [null, null, null, null, '15:25'], lunch: [null, null, null, null, { duration: 20 }], total: 0 },
    };
    const sandbox = buildSandbox({ roster: roster, assignments: assignments });
    const rep = sandbox._buildHoursReportFromData(dates, weekHoursData, ['B1', 'S3'], {});

    check('exactly one employee row (not fragmented across B1 and S3 sections)', rep.empsSeen, 1);
    const katiaLines = rep.text.split('\n').filter(function (l) { return /katia/i.test(l); });
    check('appears exactly once in the text report', katiaLines.length, 1);
    check('weekly total combines BOTH teams worked (28.84h), matching the Live tab exactly -- never fragmented into two partial sections', katiaLines[0].indexOf('28.84') !== -1, true);
    check('the old per-team grouping tag is gone -- no team code shown at all', /\(B1\)|\(S3\)/.test(katiaLines[0]), false);

    const csvRows = rep.csv.trim().split('\n').slice(1); // drop header
    check('exactly ONE CSV row for her (one employee, one total -- not one row per date/team)', csvRows.length, 1);
    check('the CSV row is just Name,Hours', csvRows[0], '"Mejia, Katia",28.84');
  }

  // ==== Analia DeSouza: default S3, manual overrides on 2 days (different
  // teams), team-GPS on the rest -- 3 distinct teams touched in one week. ====
  {
    const dates = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    const roster = [{ id: 'analia', uuid: 'analia-uuid', name: 'Analia DeSouza', defaultTeam: 'S3' }];
    const assignments = {
      '2026-08-31_analia': 'B1',
      '2026-09-01_analia': 'B3',
      '2026-09-02_analia': 'S3',
      '2026-09-03_analia': 'B1',
      '2026-09-04_analia': 'S3',
    };
    const overrides = {
      'analia_2026-08-31': { hours: 4.6, start: '09:19', end: '13:54', lunch: 0 },
      'analia_2026-09-01': { hours: 7.5, start: '09:00', end: '16:27', lunch: 0 },
    };
    const weekHoursData = {
      B1: { days: [0, 0, 0, 6.928087777777778, 0], starts: [null, null, null, '09:09', null], ends: [null, null, null, '16:08', null], lunch: [null, null, null, { duration: 3 }, null], total: 0 },
      B3: { days: [0, 0, 0, 0, 0], starts: [null, null, null, null, null], ends: [null, null, null, null, null], lunch: [null, null, null, null, null], total: 0 },
      S3: { days: [0, 0, 9.482222222222223, 0, 6.049166666666667], starts: [null, null, '08:49', null, '09:02'], ends: [null, null, '18:22', null, '15:25'], lunch: [null, null, { duration: 4 }, null, { duration: 20 }], total: 0 },
    };
    const sandbox = buildSandbox({ roster: roster, assignments: assignments, overrides: overrides });
    const rep = sandbox._buildHoursReportFromData(dates, weekHoursData, ['B1', 'B3', 'S3'], {});

    check('exactly one employee row across 3 different teams touched', rep.empsSeen, 1);
    const line = rep.text.split('\n').filter(function (l) { return /analia/i.test(l); })[0];
    check('weekly total combines all 3 teams (34.56h) -- overrides on 2 days, team-GPS on the other 3, all added together', line.indexOf('34.56') !== -1, true);

    const csvRows = rep.csv.trim().split('\n').slice(1);
    check('exactly one CSV row (not 5, not split by team)', csvRows.length, 1);
    check('the CSV row is just Name,Hours', csvRows[0], '"DeSouza, Analia",34.56');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
