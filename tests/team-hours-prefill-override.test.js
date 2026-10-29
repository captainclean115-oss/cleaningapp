// team-hours-prefill-override branch: fixes a real gap found in Step 1
// of this task -- openTeamHoursModal never read manual_hour_overrides at
// all. It always initialized Start/End/Lunch blank, then unconditionally
// overwrote them from GPS if available, regardless of whether a saved
// override already existed for that team/day. A manager reopening the
// modal after a successful Team Hours save (see team-hours-visible-save)
// would see GPS numbers instead of what was actually saved.
//
// This test extracts the real, modified code verbatim from index.html
// (same contiguous block the existing team-hours-button-apply-rollback
// test extracts -- _teamHoursEligibility through _teamHoursRefreshAfterWrite,
// which now also contains the new _teamHoursOverridePrefill() and the
// updated openTeamHoursModal()).
//
// Covers:
//   1. Override present, same for everyone -> fields show the override,
//      NOT GPS, even when GPS is available and different. Source note
//      says "Saved hours".
//   2. No override anywhere -> GPS fills the fields (unchanged
//      behavior). Source note says "GPS".
//   3. Mixed overrides (everyone has one, but they differ) -> a clear
//      note, fields stay blank -- GPS is not silently shown either, and
//      no single employee's value is silently picked.
//   4. Partial (some but not all have an override) -> GPS fills the
//      fields (unchanged), but a note says N of M already have saved
//      hours.
//   5. Reopening after a save and calling Apply without touching any
//      field writes back the EXACT same values that were already saved
//      -- the round trip is a true no-op, not a silent drift.
//
// Run with: node tests/team-hours-prefill-override.test.js

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

// Same contiguous block team-hours-button-apply-rollback.test.js
// extracts -- now also contains _teamHoursOverridePrefill and the
// updated openTeamHoursModal.
const fnSource = extract(
  'function _teamHoursEligibility(team, dateStr) {',
  '\n\n// PR #118',
  'Team Hours modal logic block'
);

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
];

function buildSandbox(opts) {
  opts = opts || {};
  const overrides = {}; // empId -> { start, end, lunch, hours, team }
  const existingOverrides = opts.existingOverrides || {};
  Object.keys(existingOverrides).forEach(function (k) { overrides[k] = existingOverrides[k]; });

  const els = {
    'team-hours-overlay': { dataset: {}, style: { display: 'none' } },
    'team-hours-title': { textContent: '' },
    'team-hours-subtitle': { textContent: '' },
    'team-hours-error': { style: {}, textContent: '' },
    'team-hours-included': { innerHTML: '' },
    'team-hours-skipped-wrap': { style: {} },
    'team-hours-skipped': { innerHTML: '' },
    'team-hours-apply-btn': { disabled: false, textContent: 'Apply to team' },
    'team-hours-reset-btn': { disabled: false },
    'team-hours-source-note': { textContent: '', style: {} },
    'team-hours-start': { value: '' },
    'team-hours-end': { value: '' },
    'team-hours-lunch': { value: '' },
    'team-hours-gps-summary': { innerHTML: '' },
    'team-hours-gps-timeline': { innerHTML: '' },
  };

  const calls = [];
  const gpsDetail = opts.gpsDetail !== undefined ? opts.gpsDetail : {
    gps: { available: true, start: new Date('2026-09-10T13:00:00Z'), end: new Date('2026-09-10T21:00:00Z'), lunchMin: 30 },
  };

  const sandbox = {
    console,
    document: {
      getElementById: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; },
    },
    alert: function (msg) { calls.push(['alert', msg]); },
    showToast: function (msg, kind) { calls.push(['showToast', msg, kind]); },
    window: {
      PentaHourOverrides: {},
      PentaEmployees: { getByLegacyRosterId: function () { return null; } },
    },
    weekHours: undefined,
    hoursWeekOffset: undefined,

    getUnifiedRoster: function () { return ROSTER.slice(); },
    getEmployeeTeam: function (empId) {
      var emp = ROSTER.find(function (e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    getRosterTermData: function () { return {}; },
    getEmployeeDayOffInfo: function () { return null; },
    DAY_OFF_CATEGORY_LABELS: {},

    calcHoursFromTimes: function (s, e, l) {
      var sp = s.split(':'), ep = e.split(':');
      var mins = (parseInt(ep[0]) * 60 + parseInt(ep[1])) - (parseInt(sp[0]) * 60 + parseInt(sp[1]));
      if (l) mins -= l;
      return Math.max(0, Math.round(mins / 6) / 10);
    },

    getEmpHours: function (empId) {
      calls.push(['getEmpHours', empId]);
      return overrides[empId] || null;
    },
    saveEmpHours: function (empId, dateStr, data) {
      calls.push(['saveEmpHours', empId, dateStr, data]);
      overrides[empId] = data;
      return Promise.resolve();
    },
    clearEmpHours: function (empId) {
      calls.push(['clearEmpHours', empId]);
      delete overrides[empId];
      return Promise.resolve();
    },
    _auditSupplement: function () { return Promise.resolve(); },
    logPendingUpdate: function () {},
    renderTeamManager: function () { return Promise.resolve(); },
    loadWeekHours: function () { return Promise.resolve(); },
    getWeekDates: function () { return []; },
    dateKey: function (d) { return d; },

    _adminEsc: function (s) { return String(s); },
    _fetchTeamDayGpsDetail: function () {
      calls.push(['_fetchTeamDayGpsDetail']);
      return Promise.resolve(gpsDetail);
    },
    _teamHoursRenderGpsTimeline: function () { calls.push(['_teamHoursRenderGpsTimeline']); },
    _pentaBusinessTimezone: function () { return 'America/New_York'; },
    _bizHM: function (date, tz) {
      // Minimal real-enough stand-in: fixed GPS wall-clock values distinct
      // from any override fixture below, so a test failure that shows GPS
      // instead of the override is unambiguous.
      return date.getTime() === new Date('2026-09-10T13:00:00Z').getTime() ? '09:00' : '17:00';
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, els, calls, overrides };
}

async function main() {
  // ── 1. Override present, same for everyone -> fields show it, not GPS ──
  {
    const { sandbox, els } = buildSandbox({
      existingOverrides: {
        e1: { start: '08:00', end: '16:00', lunch: 30, hours: 7.5, team: 'B1' },
        e2: { start: '08:00', end: '16:00', lunch: 30, hours: 7.5, team: 'B1' },
      },
    });
    await sandbox.openTeamHoursModal('B1', '2026-09-10');
    check('Start shows the saved override, not GPS (09:00)', els['team-hours-start'].value, '08:00');
    check('End shows the saved override, not GPS (17:00)', els['team-hours-end'].value, '16:00');
    check('Lunch shows the saved override', els['team-hours-lunch'].value, '30');
    checkTrue('source note says "Saved hours"', /Saved hours/.test(els['team-hours-source-note'].textContent));
  }

  // ── 2. No override anywhere -> GPS fills the fields (unchanged) ──
  {
    const { sandbox, els } = buildSandbox({});
    await sandbox.openTeamHoursModal('B1', '2026-09-10');
    check('Start filled from GPS', els['team-hours-start'].value, '09:00');
    check('End filled from GPS', els['team-hours-end'].value, '17:00');
    check('Lunch filled from GPS', els['team-hours-lunch'].value, '30');
    checkTrue('source note says "GPS"', /GPS/.test(els['team-hours-source-note'].textContent));
    check('source note does not falsely claim saved hours', /Saved hours/.test(els['team-hours-source-note'].textContent), false);
  }

  // ── 3. Mixed overrides -> note shown, fields stay blank (no GPS, no silent pick) ──
  {
    const { sandbox, els } = buildSandbox({
      existingOverrides: {
        e1: { start: '07:00', end: '15:00', lunch: 0, hours: 8, team: 'B1' },
        e2: { start: '08:00', end: '16:00', lunch: 30, hours: 7.5, team: 'B1' },
      },
    });
    await sandbox.openTeamHoursModal('B1', '2026-09-10');
    check('Start left blank (not Alice\'s 07:00, not Bob\'s 08:00, not GPS\'s 09:00)', els['team-hours-start'].value, '');
    check('End left blank', els['team-hours-end'].value, '');
    check('Lunch left blank (reset to 0, not either saved value)', els['team-hours-lunch'].value, '0');
    checkTrue('a clear "different saved hours" note is shown', /different saved hours/.test(els['team-hours-source-note'].textContent));
  }

  // ── 4. Partial: only some have an override -> GPS fills the fields, with a note ──
  {
    const { sandbox, els } = buildSandbox({
      existingOverrides: {
        e1: { start: '07:00', end: '15:00', lunch: 0, hours: 8, team: 'B1' },
        // e2 (Bob) has no override
      },
    });
    await sandbox.openTeamHoursModal('B1', '2026-09-10');
    check('Start still filled from GPS (not silently left blank, not Alice\'s saved value)', els['team-hours-start'].value, '09:00');
    check('End still filled from GPS', els['team-hours-end'].value, '17:00');
    checkTrue('note says 1 of 2 already have saved hours', /1 of 2/.test(els['team-hours-source-note'].textContent));
  }

  // ── 5. Reopen after a save, Apply without touching fields -> true no-op write ──
  {
    const savedValue = { start: '08:30', end: '16:45', lunch: 15, hours: 8, team: 'B1' };
    const { sandbox, els, calls } = buildSandbox({
      existingOverrides: { e1: savedValue, e2: savedValue },
    });
    await sandbox.openTeamHoursModal('B1', '2026-09-10');
    check('reopened fields exactly match what was saved', [els['team-hours-start'].value, els['team-hours-end'].value, els['team-hours-lunch'].value], ['08:30', '16:45', '15']);
    await sandbox.teamHoursApply(); // no field edited in between
    const saveCalls = calls.filter(function (c) { return c[0] === 'saveEmpHours'; });
    check('exactly 2 writes (Alice + Bob)', saveCalls.length, 2);
    checkTrue('Alice re-written with the EXACT same values as before (true no-op)',
      saveCalls.find(function (c) { return c[1] === 'e1'; })[3].start === savedValue.start &&
      saveCalls.find(function (c) { return c[1] === 'e1'; })[3].end === savedValue.end &&
      saveCalls.find(function (c) { return c[1] === 'e1'; })[3].lunch === savedValue.lunch);
    checkTrue('Bob re-written with the EXACT same values as before (true no-op)',
      saveCalls.find(function (c) { return c[1] === 'e2'; })[3].start === savedValue.start &&
      saveCalls.find(function (c) { return c[1] === 'e2'; })[3].end === savedValue.end &&
      saveCalls.find(function (c) { return c[1] === 'e2'; })[3].lunch === savedValue.lunch);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
