// Team Hours modal (🕐 Hours button on each team header, Team Manager
// modal -- Live + Schedule tabs, same renderTeamManager): lets Tom
// correct a whole team's hours for one day in a single action instead
// of opening each employee's own hours edit one at a time.
//
// This test exercises the pure write/validate/rollback logic
// (_teamHoursEligibility, teamHoursApply, teamHoursResetToGps) against a
// sandboxed PentaHourOverrides-shaped fake, independent of the DOM/UI
// wiring (covered separately by the puppeteer click test).
//
// Three things this specifically guards:
//   1. Inverted times (the Maria Vieira 21:00 -> 16:27 case) must be
//      rejected with a visible error, never silently clamped to 0 hours
//      the way calcHoursFromTimes's own Math.max(0, …) would otherwise
//      let through.
//   2. All-or-nothing: if any employee's write fails partway through a
//      multi-employee Apply, everything already written gets rolled
//      back to its exact prior value (or cleared, if none existed) --
//      never a half-applied team.
//   3. OFF/vacation/terminated roster members are excluded from the
//      write set and surfaced as "skipped", not silently included or
//      silently dropped with no explanation.
//
// Run with: node tests/team-hours-button-apply-rollback.test.js

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

// One contiguous block: _teamHoursEligibility through _teamHoursRefreshAfterWrite.
const fnSource = extract(
  'function _teamHoursEligibility(team, dateStr) {',
  '\n\n// PR #118',
  'Team Hours modal logic block'
);

// _bizHM -- the prefill formatter added for this feature. Extracted and
// checked on its own: Tom's explicit requirement is "business timezone,
// not browser-local" for the modal's GPS prefill, so this needs to be
// proven tz-aware, not just "doesn't crash."
const bizHmSource = extract(
  'function _bizHM(date, tz) {',
  '\n\n// Returns { fromDate, toDate',
  '_bizHM'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ── Fixtures ──
const ROSTER = [
  { id: 'e1', name: 'Alice', uuid: 'uuid-alice', defaultTeam: 'B1' },
  { id: 'e2', name: 'Bob',   uuid: 'uuid-bob',   defaultTeam: 'B1' },
  { id: 'e3', name: 'Cara',  uuid: 'uuid-cara',  defaultTeam: 'B1' }, // on vacation this date
  { id: 'e4', name: 'Dana',  uuid: 'uuid-dana',  defaultTeam: 'B1' }, // terminated
  { id: 'e5', name: 'Ella',  uuid: 'uuid-ella',  defaultTeam: 'S3' }, // different team entirely
];

function buildSandbox(opts) {
  opts = opts || {};
  const els = {
    'team-hours-overlay': { dataset: { team: opts.team || 'B1', date: opts.date || '2026-09-10' }, style: { display: 'flex' } },
    'team-hours-start': { value: opts.start !== undefined ? opts.start : '09:00' },
    'team-hours-end': { value: opts.end !== undefined ? opts.end : '17:00' },
    'team-hours-lunch': { value: opts.lunch !== undefined ? opts.lunch : '30' },
    'team-hours-error': { style: {}, textContent: '' },
    'team-hours-apply-btn': { disabled: false },
    'team-hours-reset-btn': { disabled: false },
  };

  const overrides = {}; // key: empId -> { start, end, lunch, hours, team }
  const calls = [];
  const alerts = [];

  const existingOverrides = opts.existingOverrides || {};
  Object.keys(existingOverrides).forEach(function(k) { overrides[k] = existingOverrides[k]; });

  const sandbox = {
    console,
    document: {
      getElementById: function(id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; },
    },
    alert: function(msg) { alerts.push(msg); },
    window: {
      PentaHourOverrides: {},
      PentaEmployees: { getByLegacyRosterId: function() { return null; } },
    },
    weekHours: undefined,
    hoursWeekOffset: undefined,

    getUnifiedRoster: function() { return ROSTER.slice(); },
    getEmployeeTeam: function(empId, dateStr) {
      if (empId === 'e3' || empId === 'e4') return null; // off/terminated -> not on any team today
      var emp = ROSTER.find(function(e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    getRosterTermData: function() { return { e4: { status: 'terminated' } }; },
    getEmployeeDayOffInfo: function(empId) { return empId === 'e3' ? { status_type: 'vacation' } : null; },
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },

    calcHoursFromTimes: function(s, e, l) {
      var sp = s.split(':'), ep = e.split(':');
      var mins = (parseInt(ep[0]) * 60 + parseInt(ep[1])) - (parseInt(sp[0]) * 60 + parseInt(sp[1]));
      if (l) mins -= l;
      return Math.max(0, Math.round(mins / 6) / 10);
    },

    getEmpHours: function(empId) {
      calls.push(['getEmpHours', empId]);
      return overrides[empId] || null;
    },
    saveEmpHours: function(empId, dateStr, data) {
      calls.push(['saveEmpHours', empId, dateStr, data]);
      if (opts.saveFailsFor && opts.saveFailsFor === empId) return Promise.reject(new Error('network timeout'));
      overrides[empId] = data;
      return Promise.resolve();
    },
    clearEmpHours: function(empId) {
      calls.push(['clearEmpHours', empId]);
      if (opts.clearFailsFor && opts.clearFailsFor === empId) return Promise.reject(new Error('RLS denied'));
      delete overrides[empId];
      return Promise.resolve();
    },
    _auditSupplement: function(actionType, entityType, entityId, newValues) {
      calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    },
    logPendingUpdate: function(action, details) { calls.push(['logPendingUpdate', action, details]); },
    renderTeamManager: function() { calls.push(['renderTeamManager']); return Promise.resolve(); },
    loadWeekHours: function() { calls.push(['loadWeekHours']); return Promise.resolve(); },
    getWeekDates: function() { return []; },
    dateKey: function(d) { return d; },
    closeTeamHoursModal: function() { calls.push(['closeTeamHoursModal']); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, els, calls, alerts, overrides };
}

async function main() {
  // ── _teamHoursEligibility ──
  {
    const { sandbox } = buildSandbox();
    const elig = sandbox._teamHoursEligibility('B1', '2026-09-10');
    check('included = Alice + Bob only (Cara is vacation, Dana terminated, Ella is a different team)',
      elig.included.map(function(e) { return e.name; }).sort(), ['Alice', 'Bob']);
    check('skipped includes Cara with reason Vacation',
      !!elig.skipped.find(function(s) { return s.emp.name === 'Cara' && s.reason === 'Vacation'; }), true);
    check('skipped includes Dana with reason Terminated',
      !!elig.skipped.find(function(s) { return s.emp.name === 'Dana' && s.reason === 'Terminated'; }), true);
    check('skipped does NOT include Ella (different team, not this team\'s concern today)',
      !!elig.skipped.find(function(s) { return s.emp.name === 'Ella'; }), false);
    check('exactly 2 skipped (Cara, Dana)', elig.skipped.length, 2);
  }

  // ── Inverted times rejected (the Maria Vieira case) ──
  {
    const { sandbox, calls, els } = buildSandbox({ start: '21:00', end: '16:27' });
    await sandbox.teamHoursApply();
    check('no writes happen when end <= start', calls.some(function(c) { return c[0] === 'saveEmpHours'; }), false);
    check('a visible error is shown in the modal', els['team-hours-error'].style.display, '');
    check('the error names both times', /21:00/.test(els['team-hours-error'].textContent) && /16:27/.test(els['team-hours-error'].textContent), true);
  }

  // Equal start/end also rejected (zero-length shift is not a valid "hours" edit).
  {
    const { sandbox, calls } = buildSandbox({ start: '09:00', end: '09:00' });
    await sandbox.teamHoursApply();
    check('equal start/end is rejected too (not >0 hours)', calls.some(function(c) { return c[0] === 'saveEmpHours'; }), false);
  }

  // Missing start or end rejected.
  {
    const { sandbox, calls } = buildSandbox({ start: '', end: '17:00' });
    await sandbox.teamHoursApply();
    check('blank start is rejected before any write', calls.some(function(c) { return c[0] === 'saveEmpHours'; }), false);
  }

  // ── Happy path: writes one row per included employee, skips the rest ──
  {
    const { sandbox, calls, els } = buildSandbox({ start: '08:30', end: '16:30', lunch: '30' });
    await sandbox.teamHoursApply();
    const saveCalls = calls.filter(function(c) { return c[0] === 'saveEmpHours'; });
    check('exactly 2 saveEmpHours calls (Alice, Bob only)', saveCalls.length, 2);
    check('Alice\'s write carries the right data', saveCalls.find(function(c) { return c[1] === 'e1'; })[3],
      { start: '08:30', end: '16:30', lunch: 30, hours: 7.5, team: 'B1' });
    check('one audit_log supplement per included employee, source=team_hours_button',
      calls.filter(function(c) { return c[0] === '_auditSupplement' && c[4].source === 'team_hours_button'; }).length, 2);
    check('audit entries use action_type manual_override / entity_type employee',
      calls.filter(function(c) { return c[0] === '_auditSupplement'; }).every(function(c) { return c[1] === 'manual_override' && c[2] === 'employee'; }), true);
    check('an activity-log entry is written (logPendingUpdate)', calls.some(function(c) { return c[0] === 'logPendingUpdate'; }), true);
    check('modal closes on success (the real closeTeamHoursModal hides the overlay)', els['team-hours-overlay'].style.display, 'none');
    check('no error shown on success', els['team-hours-error'].style.display, 'none');
  }

  // ── All-or-nothing rollback: Bob's write fails after Alice's succeeded ──
  {
    const { sandbox, calls, overrides, els } = buildSandbox({
      start: '08:00', end: '16:00', lunch: '0', saveFailsFor: 'e2',
      existingOverrides: { e1: { start: '07:00', end: '15:00', lunch: 0, hours: 8, team: 'B1' } },
    });
    await sandbox.teamHoursApply();
    const saveCalls = calls.filter(function(c) { return c[0] === 'saveEmpHours'; });
    // Alice (e1) written with the new value, then rolled back to her prior value --
    // two saveEmpHours calls for e1 (new, then rollback-restore), one failing attempt for e2.
    check('Alice was written with the new value before the failure', saveCalls[0], ['saveEmpHours', 'e1', '2026-09-10', { start: '08:00', end: '16:00', lunch: 0, hours: 8, team: 'B1' }]);
    check('Bob\'s write was attempted and failed', saveCalls.some(function(c) { return c[1] === 'e2'; }), true);
    check('Alice was rolled back to her EXACT prior value (not cleared)', overrides.e1, { start: '07:00', end: '15:00', lunch: 0, hours: 8, team: 'B1' });
    check('Bob never ended up with any override (write never succeeded)', overrides.e2, undefined);
    check('nothing claims success -- modal stays open', els['team-hours-overlay'].style.display, 'flex');
  }

  // All-or-nothing rollback, no prior override for the succeeded employee -- rollback must CLEAR, not leave the new value.
  {
    const { sandbox, overrides } = buildSandbox({ start: '08:00', end: '16:00', lunch: '0', saveFailsFor: 'e2' });
    await sandbox.teamHoursApply();
    check('Alice had no prior override, so rollback clears her entirely rather than leaving the new value', overrides.e1, undefined);
  }

  // ── Reset to GPS ──
  {
    const { sandbox, calls, overrides } = buildSandbox({
      existingOverrides: {
        e1: { start: '07:00', end: '15:00', lunch: 0, hours: 8, team: 'B1' },
        e2: { start: '07:30', end: '15:30', lunch: 30, hours: 7.5, team: 'B1' },
      },
    });
    await sandbox.teamHoursResetToGps();
    check('both included employees\' overrides are cleared', [overrides.e1, overrides.e2], [undefined, undefined]);
    check('exactly 2 clearEmpHours calls', calls.filter(function(c) { return c[0] === 'clearEmpHours'; }).length, 2);
    check('reset also writes an audit_log supplement per cleared employee', calls.filter(function(c) { return c[0] === '_auditSupplement'; }).length, 2);
  }

  // Reset rollback: Bob's clear fails after Alice's succeeded -- Alice restored.
  {
    const { sandbox, overrides } = buildSandbox({
      clearFailsFor: 'e2',
      existingOverrides: {
        e1: { start: '07:00', end: '15:00', lunch: 0, hours: 8, team: 'B1' },
        e2: { start: '07:30', end: '15:30', lunch: 30, hours: 7.5, team: 'B1' },
      },
    });
    await sandbox.teamHoursResetToGps();
    check('Alice is restored to her exact prior override after Bob\'s clear fails', overrides.e1, { start: '07:00', end: '15:00', lunch: 0, hours: 8, team: 'B1' });
    check('Bob (the one that failed to clear) keeps his original override (clear never actually succeeded)', overrides.e2, { start: '07:30', end: '15:30', lunch: 30, hours: 7.5, team: 'B1' });
  }

  // ── _bizHM business-timezone correctness ──
  // "business timezone, not browser-local" is an explicit requirement
  // for this modal's prefill. Proven here by checking the SAME UTC
  // instant against two different tz arguments and expecting different
  // answers (if this were secretly using the system/browser-local zone
  // or always UTC, these would collide instead of differing correctly).
  {
    const bizSandbox = { Intl };
    vm.createContext(bizSandbox);
    vm.runInContext(bizHmSource, bizSandbox);

    // 2026-01-15 14:30 UTC, winter -- EST is UTC-5, PST is UTC-8.
    const winterUtc = new Date('2026-01-15T14:30:00Z');
    check('business tz (America/New_York, EST winter) renders 09:30, not UTC\'s 14:30',
      bizSandbox._bizHM(winterUtc, 'America/New_York'), '09:30');
    check('a different tz (America/Los_Angeles, PST) renders a different wall-clock time for the SAME instant',
      bizSandbox._bizHM(winterUtc, 'America/Los_Angeles'), '06:30');

    // 2026-07-15 13:00 UTC, summer -- EDT is UTC-4 (DST), not the winter UTC-5 offset.
    const summerUtc = new Date('2026-07-15T13:00:00Z');
    check('DST is honored -- EDT summer offset (UTC-4) differs from EST winter offset (UTC-5)',
      bizSandbox._bizHM(summerUtc, 'America/New_York'), '09:00');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function(e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
