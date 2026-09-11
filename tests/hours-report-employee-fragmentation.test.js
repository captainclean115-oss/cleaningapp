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
// report -- the two together (28h 50m) match the Live tab's 28.8h
// exactly, but read as a report, it looked like her total was 22h47m,
// a "6 hour" discrepancy that was actually just a missing second section.
//
// This test extracts the REAL _buildHoursReportFromData (not a
// reimplementation) and asserts:
//   1. An employee who worked more than one team that week appears
//      EXACTLY ONCE, grouped under their default team (matching
//      renderHoursTable's PR #109 Item 1 behavior).
//   2. Their weekly total correctly sums hours from EVERY team worked
//      that week, not just the days matching their default team.
//   3. Each day's CSV/text row is labeled with the team ACTUALLY worked
//      that day (a real cross-team day), not silently attributed to
//      their default team.
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

const helpersSrc = extract('function _hrTo24hr(d) {', '\n\n// Tom: Export Hours Report always used');
const fnSrc = extract('function _buildHoursReportFromData(dates, weekHoursData, teams) {', '\n\nfunction _hrDownloadCsv(');

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [];
  const assignments = opts.assignments || {}; // { 'date_empId': team }
  const overrides = opts.overrides || {}; // { 'empId_date': {...} }
  const sandbox = {
    console,
    window: { PentaTenant: null },
    getUnifiedRoster: function () { return roster; },
    getEmployeeTeam: function (empId, dk) {
      var key = dk + '_' + empId;
      return Object.prototype.hasOwnProperty.call(assignments, key) ? assignments[key] : null;
    },
    getEmpHours: function (empId, dk) { return overrides[empId + '_' + dk] || null; },
  };
  vm.createContext(sandbox);
  vm.runInContext(helpersSrc, sandbox);
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
    const rep = sandbox._buildHoursReportFromData(dates, weekHoursData, ['B1', 'S3']);

    check('exactly one employee row (not fragmented across B1 and S3 sections)', rep.empsSeen, 1);
    const katiaHeaderLines = rep.text.split('\n').filter(function (l) { return /KATIA/i.test(l); });
    check('appears exactly once in the text report', katiaHeaderLines.length, 1);
    check('grouped under her DEFAULT team (B1), not the cross-team day', katiaHeaderLines[0].indexOf('(B1)') !== -1, true);
    check('weekly total combines BOTH teams worked (28h 50m), matching the Live tab exactly', katiaHeaderLines[0].indexOf('28h 50m') !== -1, true);

    const csvRows = rep.csv.trim().split('\n').slice(1); // drop header
    check('5 CSV rows (one per date), not 10 (fragmented across 2 team sections)', csvRows.length, 5);
    const sep4Row = csvRows.find(function (r) { return r.indexOf('2026-09-04') !== -1; });
    check('the cross-team day (Sep 4) is correctly labeled S3 in the CSV, not silently attributed to her default B1', sep4Row.split(',')[1], 'S3');
    const sep1Row = csvRows.find(function (r) { return r.indexOf('2026-09-01') !== -1; });
    check('a normal default-team day is still labeled correctly (B1)', sep1Row.split(',')[1], 'B1');
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
    const rep = sandbox._buildHoursReportFromData(dates, weekHoursData, ['B1', 'B3', 'S3']);

    check('exactly one employee row across 3 different teams touched', rep.empsSeen, 1);
    const line = rep.text.split('\n').filter(function (l) { return /ANALIA/i.test(l); })[0];
    check('grouped under her default team (S3)', line.indexOf('(S3)') !== -1, true);
    check('weekly total combines all 3 teams (34h 34m), matching the Live tab', line.indexOf('34h 34m') !== -1, true);

    const csvRows = rep.csv.trim().split('\n').slice(1);
    check('5 CSV rows, one per date', csvRows.length, 5);
    check('Aug 31 correctly labeled B1 (manual override day)', csvRows[0].split(',')[1], 'B1');
    check('Sep 1 correctly labeled B3 (manual override day)', csvRows[1].split(',')[1], 'B3');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
