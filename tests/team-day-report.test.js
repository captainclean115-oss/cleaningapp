// Team Day Report (manager Hours tab, team-day-report branch): a
// read-only report of who was on which team per day, when each team
// left/returned to the office, each client home visited, and lunch
// taken, for a chosen date range. Writes nothing anywhere -- every
// number is read from data this file already fetches for other screens
// (getUnifiedRoster/_teamHoursEligibility for roster, the
// manual_hour_overrides cache via getEmpHours for saved hours, and the
// same live-Geotab _fetchTeamDayGpsDetail the Team Hours modal's own GPS
// prefill uses for office times + client stops).
//
// This test extracts the real _teamHoursEligibility (same block the
// existing team-hours-button-apply-rollback test extracts, for genuine
// terminated/day-off exclusion, not a stub) together with the real Team
// Day Report module (_tdrExpandDateRange, _tdrBuildEmployeeRow,
// _tdrBuildDateRows, _tdrComputeTotals, _tdrBuildCsv, _tdrRunReport) and
// the real dateKey/_hrCsvField helpers, verbatim from index.html.
//
// Run with: node tests/team-day-report.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const eligSource = extract(
  'function _teamHoursEligibility(team, dateStr) {',
  '\n\n// PR #118',
  'Team Hours eligibility block'
);
const dateKeySource = extract('function dateKey(d) {', '\n\nfunction jobsForDate', 'dateKey');
const hrCsvFieldSource = extract('function _hrCsvField(s) {', '\n\n// Tom: Export Hours Report always used', '_hrCsvField');
const tdrSource = extract(
  'var TDR_MAX_RANGE_DAYS = 31;',
  '\nfunction openTeamDayReport() {',
  'Team Day Report module'
);

const fnSource = eligSource + '\n' + dateKeySource + '\n' + hrCsvFieldSource + '\n' + tdrSource;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ── Fixtures ──
const ROSTER = [
  { id: 'e1', name: 'Alice', uuid: 'uuid-alice', defaultTeam: 'B1' },
  { id: 'e2', name: 'Bob',   uuid: 'uuid-bob',   defaultTeam: 'B1' },
  { id: 'e3', name: 'Cara',  uuid: 'uuid-cara',  defaultTeam: 'B1' }, // on vacation this date
  { id: 'e4', name: 'Dana',  uuid: 'uuid-dana',  defaultTeam: 'B1' }, // terminated as of this date
];

function buildSandbox(opts) {
  opts = opts || {};
  const overrides = opts.overrides || {}; // empId -> { start, end, lunch, hours }
  const gpsResults = opts.gpsResults || {}; // 'team|date' -> detail object, or an Error instance to throw
  const calls = [];

  const sandbox = {
    console,
    document: { getElementById: function () { return null; } }, // _tdrRunReport bails out visibly if the sheet isn't open -- exercised directly below
    alert: function (msg) { calls.push(['alert', msg]); },
    window: { PentaEmployees: { getByLegacyRosterId: function () { return null; } } },

    getUnifiedRoster: function () { return ROSTER.slice(); },
    getEmployeeTeam: function (empId) {
      if (empId === 'e3' || empId === 'e4') return null; // off/terminated -> not on any team today
      var emp = ROSTER.find(function (e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    getRosterTermData: function () { return { e4: { status: 'terminated' } }; },
    getEmployeeDayOffInfo: function (empId) { return empId === 'e3' ? { status_type: 'vacation' } : null; },
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },

    getEmpHours: function (empId, dateStr) {
      calls.push(['getEmpHours', empId, dateStr]);
      return overrides[empId] || null;
    },
    _fetchTeamDayGpsDetail: function (team, dateStr) {
      calls.push(['_fetchTeamDayGpsDetail', team, dateStr]);
      var key = team + '|' + dateStr;
      var v = gpsResults[key];
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(v || { device: null, resolved: {}, trips: [], stopList: [], gps: { available: false, reason: 'No GPS device assigned' } });
    },
    _bizHM: function (date) {
      // Deterministic stand-in: HH:MM derived from the UTC hour/minute so
      // different fixture times produce visibly different strings.
      var d = (date instanceof Date) ? date : new Date(date);
      return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    },
    matchStopToClientGeo: function (lat, lng, addr) {
      if (opts.clientMatchFor && opts.clientMatchFor[addr]) return opts.clientMatchFor[addr];
      return null;
    },
    jobs: opts.jobs || [],
    _pentaTeamNames: function () { return opts.teams || ['B1']; },
    _pentaBusinessTimezone: function () { return 'America/New_York'; },
    _adminEsc: function (s) { return String(s); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, calls };
}

async function main() {
  // ── _teamHoursEligibility still real: terminated/vacation exclusion carries through ──
  {
    const { sandbox } = buildSandbox({});
    const elig = sandbox._teamHoursEligibility('B1', '2026-09-10');
    check('included = Alice + Bob only (Cara vacation, Dana terminated)',
      elig.included.map(function (e) { return e.name; }).sort(), ['Alice', 'Bob']);
  }

  // ── _tdrExpandDateRange ──
  {
    const { sandbox } = buildSandbox({});
    const single = sandbox._tdrExpandDateRange('2026-09-10', '2026-09-10');
    check('single-day range expands to exactly one date', single, { ok: true, dates: ['2026-09-10'] });

    const week = sandbox._tdrExpandDateRange('2026-09-10', '2026-09-16');
    check('a 7-day range expands to 7 dates in order', week.ok && week.dates, true && ['2026-09-10','2026-09-11','2026-09-12','2026-09-13','2026-09-14','2026-09-15','2026-09-16']);

    const backwards = sandbox._tdrExpandDateRange('2026-09-16', '2026-09-10');
    check('To before From is rejected with a visible message', backwards.ok, false);
    checkTrue('rejection message mentions the ordering', /on or after/.test(backwards.error));

    const tooLong = sandbox._tdrExpandDateRange('2026-01-01', '2026-03-01'); // 60 days
    check('a range over the 31-day cap is rejected', tooLong.ok, false);
    checkTrue('cap-rejection message names the 31-day limit', /31 days/.test(tooLong.error));

    const atCap = sandbox._tdrExpandDateRange('2026-01-01', '2026-01-31'); // exactly 31 days
    check('exactly 31 days is accepted (the cap itself is not rejected)', atCap.ok, true);
    check('exactly 31 days produces 31 dates', atCap.dates.length, 31);

    const missing = sandbox._tdrExpandDateRange('', '2026-09-10');
    check('a missing date is rejected with a visible message, not a crash', missing.ok, false);
  }

  // ── _tdrBuildEmployeeRow: override beats GPS ──
  {
    const { sandbox } = buildSandbox({
      overrides: { e1: { start: '08:00', end: '16:00', lunch: 30, hours: 7.5 } },
      gpsResults: { 'B1|2026-09-10': { device: {}, stopList: [], gps: { available: true, start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'), lunchMin: 45 } } },
    });
    const gpsOutcome = { ok: true, detail: { gps: { available: true, start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'), lunchMin: 45 }, stopList: [] } };
    const row = sandbox._tdrBuildEmployeeRow({ id: 'e1', name: 'Alice' }, 'B1', '2026-09-10', gpsOutcome, 'America/New_York');
    check('a saved override wins over an available GPS result', [row.leftOffice, row.backOffice, row.lunchMin, row.source], ['08:00', '16:00', 30, 'Saved']);
  }

  // ── _tdrBuildEmployeeRow: no override -> falls back to GPS ──
  {
    const { sandbox } = buildSandbox({});
    const gpsOutcome = { ok: true, detail: { gps: { available: true, start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'), lunchMin: 30 }, stopList: [] } };
    const row = sandbox._tdrBuildEmployeeRow({ id: 'e1', name: 'Alice' }, 'B1', '2026-09-10', gpsOutcome, 'America/New_York');
    check('no override -> uses GPS, labeled GPS', [row.leftOffice, row.backOffice, row.lunchMin, row.source], ['13:00', '21:00', 30, 'GPS']);
  }

  // ── _tdrBuildEmployeeRow: neither override nor GPS -> "No data", never blank ──
  {
    const { sandbox } = buildSandbox({});
    const gpsOutcome = { ok: true, detail: { gps: { available: false, reason: 'No device' }, stopList: [] } };
    const row = sandbox._tdrBuildEmployeeRow({ id: 'e1', name: 'Alice' }, 'B1', '2026-09-10', gpsOutcome, 'America/New_York');
    check('no override, GPS unavailable -> hours fields are null (rendered as "No data"), source "No data"', [row.leftOffice, row.backOffice, row.lunchMin, row.source], [null, null, null, 'No data']);
    check('stopsNote is "No data" when the GPS fetch itself had nothing', row.stopsNote, 'No data');
  }

  // A fetch that genuinely failed (not just "no device") -- also "No data", not a crash, and loadError is carried for display.
  {
    const { sandbox } = buildSandbox({});
    const gpsOutcome = { ok: false, error: 'Geotab timeout' };
    const row = sandbox._tdrBuildEmployeeRow({ id: 'e1', name: 'Alice' }, 'B1', '2026-09-10', gpsOutcome, 'America/New_York');
    check('a failed fetch still produces "No data", not a thrown error', [row.leftOffice, row.source, row.stopsNote], [null, 'No data', 'No data']);
    check('the failure reason is carried on the row for display', row.loadError, 'Geotab timeout');
  }

  // ── Client homes: matched name vs "Unrecognized stop" ──
  {
    const { sandbox } = buildSandbox({
      clientMatchFor: { '123 Main St': { name: 'Jane Smith', id: 'c1', scheduled: true } },
    });
    const gpsOutcome = {
      ok: true,
      detail: {
        gps: { available: true, start: new Date(), end: new Date(), lunchMin: 0 },
        stopList: [
          { addr: '123 Main St', inTime: new Date('2026-09-10T14:00:00Z'), outTime: new Date('2026-09-10T14:30:00Z'), isDepot: false },
          { addr: '456 Oak Ave', inTime: new Date('2026-09-10T15:00:00Z'), outTime: new Date('2026-09-10T15:20:00Z'), isDepot: false },
          { addr: 'Depot', inTime: new Date('2026-09-10T12:00:00Z'), outTime: new Date('2026-09-10T12:05:00Z'), isDepot: true },
        ],
      },
    };
    const row = sandbox._tdrBuildEmployeeRow({ id: 'e1', name: 'Alice' }, 'B1', '2026-09-10', gpsOutcome, 'America/New_York');
    check('depot stops are excluded from client homes visited', row.stops.length, 2);
    check('a matched stop shows the client name', row.stops[0].label, 'Jane Smith');
    check('an unmatched stop shows "Unrecognized stop" plus its address', [row.stops[1].label, row.stops[1].addr], ['Unrecognized stop', '456 Oak Ave']);
  }

  // ── _tdrBuildDateRows: terminated-after-date appears, terminated-before does not ──
  {
    const { sandbox } = buildSandbox({});
    sandbox._tdrGeneration = 1;
    const rows = await sandbox._tdrBuildDateRows('2026-09-10', 'America/New_York', 1, null);
    const names = rows.map(function (r) { return r.employeeName; }).filter(Boolean);
    checkTrue('Alice and Bob (active, on the team) appear', names.indexOf('Alice') !== -1 && names.indexOf('Bob') !== -1);
    check('Dana (terminated as of this date, per getRosterTermData/eligibility) does not appear', names.indexOf('Dana'), -1);
    check('Cara (day off) does not appear', names.indexOf('Cara'), -1);
  }

  // A date with nobody on any team at all -> a single "No assignment recorded" marker, not an empty/silent result.
  {
    const { sandbox } = buildSandbox({ teams: ['Z9'] }); // a team nobody is on
    sandbox._tdrGeneration = 1;
    const rows = await sandbox._tdrBuildDateRows('2026-09-10', 'America/New_York', 1, null);
    check('exactly one marker row for a day with no coverage at all', rows.length, 1);
    checkTrue('marker row is noAssignment', rows[0].noAssignment);
  }

  // ── One team's GPS fetch throwing does not stop other teams on the same date ──
  {
    const { sandbox } = buildSandbox({
      teams: ['B1', 'S1'],
      gpsResults: { 'S1|2026-09-10': new Error('Geotab rate limited') },
    });
    sandbox.getEmployeeTeam = function (empId, dateStr) {
      // Give S1 its own included employee too, independent of the B1 fixture above.
      if (empId === 'e1') return 'B1';
      if (empId === 'e5') return 'S1';
      return null;
    };
    sandbox.getUnifiedRoster = function () { return [{ id: 'e1', name: 'Alice', defaultTeam: 'B1' }, { id: 'e5', name: 'Eve', defaultTeam: 'S1' }]; };
    sandbox._tdrGeneration = 1;
    const rows = await sandbox._tdrBuildDateRows('2026-09-10', 'America/New_York', 1, null);
    checkTrue('B1 (the team whose fetch succeeded) still produced a real employee row', rows.some(function (r) { return r.employeeName === 'Alice'; }));
    checkTrue('S1 (the team whose fetch threw) produced a real employee row too -- _fetchTeamDayGpsDetail failures are caught INSIDE the fetch helper, never killing the team', rows.some(function (r) { return r.employeeName === 'Eve' && r.source === 'No data' && r.loadError === 'Geotab rate limited'; }));
    check('no loadFailed marker row needed here -- the per-team fetch failure degrades to "No data" on real rows, not a dropped team', rows.some(function (r) { return r.loadFailed; }), false);
  }

  // ── _tdrComputeTotals ──
  {
    const { sandbox } = buildSandbox({});
    const rows = [
      { date: '2026-09-10', team: 'B1', employeeName: 'Alice' },
      { date: '2026-09-10', team: 'B1', employeeName: 'Bob' },
      { date: '2026-09-10', team: 'S1', employeeName: 'Eve' },
      { date: '2026-09-11', team: 'B1', employeeName: 'Alice' },
      { date: '2026-09-11', team: null, noAssignment: true },
      { date: '2026-09-12', team: 'B1', loadFailed: true, reason: 'x' },
    ];
    const totals = sandbox._tdrComputeTotals(rows);
    check('team-days counts distinct date+team pairs, excluding marker rows', totals.teamDays, 3);
    check('employee-days counts only real employee rows', totals.employeeDays, 4);
  }

  // ── No money/pay fields anywhere in a built row ──
  {
    const { sandbox } = buildSandbox({ overrides: { e1: { start: '08:00', end: '16:00', lunch: 30, hours: 7.5 } } });
    const gpsOutcome = { ok: true, detail: { gps: { available: false }, stopList: [] } };
    const row = sandbox._tdrBuildEmployeeRow({ id: 'e1', name: 'Alice' }, 'B1', '2026-09-10', gpsOutcome, 'America/New_York');
    const keys = Object.keys(row).join(' ').toLowerCase();
    checkTrue('no pay/rate/cost/money field anywhere on the row', !/pay|rate|cost|\$|money/.test(keys));
  }

  // ── CSV escaping ──
  {
    const { sandbox } = buildSandbox({});
    const rows = [
      { date: '2026-09-10', team: 'B1', employeeName: 'Alice, "Al"', leftOffice: '08:00', backOffice: '16:00', lunchMin: 30, source: 'Saved',
        stops: [{ label: 'Smith, Jane', addr: '1 Main St, Apt "B"\nUnit 2', inTime: '09:00', outTime: '09:20' }] },
      { date: '2026-09-11', team: null, noAssignment: true },
      { date: '2026-09-12', team: 'B1', loadFailed: true, reason: 'Geotab timeout, retry failed' },
    ];
    const csv = sandbox._tdrBuildCsv(rows);
    const lines = csv.split('\r\n');
    check('header row present', lines[0], 'Date,Team,Employee,Left office,Back at office,Lunch (min),Client homes visited,Source');
    checkTrue('a name containing a comma and quotes is quoted and quote-doubled', lines[1].indexOf('"Alice, ""Al"""') !== -1);
    // The whole "Client homes visited" field (label + address + times) is
    // one combined CSV field, escaped once as a unit -- not per sub-part --
    // so a comma/quote/newline anywhere inside it quotes the WHOLE field.
    checkTrue('a comma/quote/newline anywhere in the combined visits field quotes the whole field and doubles the quotes',
      lines[1] === '2026-09-10,B1,"Alice, ""Al""",08:00,16:00,30,"Smith, Jane, 1 Main St, Apt ""B""\nUnit 2 (09:00-09:20)",Saved');
    checkTrue('the no-assignment marker row renders as a real CSV line, not a blank', lines[2].indexOf('No assignment recorded') !== -1);
    checkTrue('the load-failed marker row carries its reason, with its own internal comma quoted', lines[3].indexOf('"Could not load: Geotab timeout, retry failed"') !== -1);
    check('exactly 4 lines (header + 3 data rows)', lines.length, 4);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
