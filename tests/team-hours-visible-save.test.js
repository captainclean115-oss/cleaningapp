// team-hours-visible-save branch: fixes the "Team Hours edit doesn't
// stick" report, which turned out to be a visibility bug, not a write
// bug (see project memory / diagnosis). Two real production rows showed
// the exact same edit written twice ~19s apart for the same employees --
// Apply gave no visible sign the first tap had already worked, and the
// only "hours" number on the Team Assignments card (_teamDayStats'
// hLabel) is scheduled job minutes, unrelated to the saved override.
//
// This test extracts the real, modified code verbatim from index.html
// (same pattern as tests/team-hours-button-apply-rollback.test.js) and
// covers:
//   1. Double-tap guard: two near-simultaneous teamHoursApply() calls
//      write each employee's override exactly once, not twice.
//   2. Success shows a toast; failure shows the existing error and NO
//      success toast.
//   3. The team card's new "Worked" line appears only when a saved
//      override exists for that team/day, and the existing "Scheduled"
//      number is unchanged either way.
//
// Run with: node tests/team-hours-visible-save.test.js

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

// Same contiguous block the existing rollback test extracts -- includes
// teamHoursApply with this branch's in-flight guard + toast call.
const fnSource = extract(
  'function _teamHoursEligibility(team, dateStr) {',
  '\n\n// PR #118',
  'Team Hours modal logic block'
);

// The per-team card HTML-building body from renderTeamManager, extracted
// on its own (it lives inside a giant async function full of unrelated
// GPS/floater logic that isn't worth sandboxing). Wrapped below as its
// own function(team, dateStr) returning the card's html string.
// "const color = ..." and "teams.forEach(team => {" both repeat
// elsewhere in this huge file, so anchor on the unique comment right
// above this specific per-team card block, then slice from the real
// start of the code within that unique region.
const cardBlockRegion = extract(
  'Bug fix: this whole callback used to run unguarded.',
  '\n   } catch (e) {',
  'renderTeamManager per-team card body (region)'
);
const _colorLineStart = cardBlockRegion.indexOf("const color = _pentaTeamColor(team, '#6b7280');");
if (_colorLineStart === -1) { console.error('FAIL: could not find card body start within its unique region'); process.exit(1); }
const cardBodySource = cardBlockRegion.slice(_colorLineStart);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ── Fixtures (same roster shape as the rollback test) ──
const ROSTER = [
  { id: 'e1', name: 'Alice', uuid: 'uuid-alice', defaultTeam: 'B1', role: [] },
  { id: 'e2', name: 'Bob',   uuid: 'uuid-bob',   defaultTeam: 'B1', role: [] },
];

function buildApplySandbox(opts) {
  opts = opts || {};
  const els = {
    'team-hours-overlay': { dataset: { team: opts.team || 'B1', date: opts.date || '2026-09-10' }, style: { display: 'flex' } },
    'team-hours-start': { value: opts.start !== undefined ? opts.start : '09:00' },
    'team-hours-end': { value: opts.end !== undefined ? opts.end : '17:00' },
    'team-hours-lunch': { value: opts.lunch !== undefined ? opts.lunch : '30' },
    'team-hours-error': { style: {}, textContent: '' },
    'team-hours-apply-btn': { disabled: false, textContent: 'Apply to team' },
    'team-hours-reset-btn': { disabled: false },
  };

  const overrides = {}; // key: empId -> { start, end, lunch, hours, team }
  const calls = [];
  const toasts = [];

  const existingOverrides = opts.existingOverrides || {};
  Object.keys(existingOverrides).forEach(function (k) { overrides[k] = existingOverrides[k]; });

  // saveEmpHours delay: lets the test fire a second teamHoursApply() call
  // while the first one's write is still pending, to actually exercise
  // the in-flight race rather than just asserting on a flag's existence.
  let resolveFirstSave = null;
  const sandbox = {
    console,
    document: {
      getElementById: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; },
    },
    alert: function (msg) { calls.push(['alert', msg]); },
    showToast: function (msg, kind) { toasts.push({ msg: msg, kind: kind }); },
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
      if (opts.saveFailsFor && opts.saveFailsFor === empId) return Promise.reject(new Error('network timeout'));
      if (opts.delayFirstSaveFor && opts.delayFirstSaveFor === empId && !resolveFirstSave) {
        return new Promise(function (resolve) {
          resolveFirstSave = function () { overrides[empId] = data; resolve(); };
        });
      }
      overrides[empId] = data;
      return Promise.resolve();
    },
    clearEmpHours: function (empId) {
      calls.push(['clearEmpHours', empId]);
      delete overrides[empId];
      return Promise.resolve();
    },
    _auditSupplement: function (actionType, entityType, entityId, newValues) {
      calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    },
    logPendingUpdate: function (action, details) { calls.push(['logPendingUpdate', action, details]); },
    renderTeamManager: function () { calls.push(['renderTeamManager']); return Promise.resolve(); },
    loadWeekHours: function () { calls.push(['loadWeekHours']); return Promise.resolve(); },
    getWeekDates: function () { return []; },
    dateKey: function (d) { return d; },
    closeTeamHoursModal: function () { calls.push(['closeTeamHoursModal']); els['team-hours-overlay'].style.display = 'none'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return {
    sandbox, els, calls, toasts, overrides,
    releaseFirstSave: function () { if (resolveFirstSave) resolveFirstSave(); },
  };
}

function buildCardSandbox(opts) {
  opts = opts || {};
  const overrides = opts.overrides || {}; // empId -> { hours, ... }
  const sandbox = {
    console,
    team: opts.team || 'B1',
    dateStr: opts.dateStr || '2026-09-10',
    getUnifiedRoster: function () { return ROSTER.slice(); },
    getEmployeeTeam: function (empId) {
      var emp = ROSTER.find(function (e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    isActiveEmp: function () { return true; },
    _teamDayStats: function () { return { houses: 3, revenue: 450, mins: 510 }; }, // 8h 30m scheduled, unrelated to overrides
    getEmpHours: function (empId) { return overrides[empId] || null; },
    _pentaTeamColor: function () { return '#6b7280'; },
    _teamDeviceMap: {},
    _gpsDevices: [],
    _adminEsc: function (s) { return String(s); },
  };
  vm.createContext(sandbox);
  const html = vm.runInContext('var html = "";\n' + cardBodySource + '\nhtml;', sandbox);
  return { html: html };
}

async function main() {
  // ── 1. Double-tap: second call while the first's save is in flight writes once per employee ──
  {
    const { sandbox, calls, releaseFirstSave } = buildApplySandbox({
      start: '09:00', end: '13:39', lunch: '0', delayFirstSaveFor: 'e1',
    });
    const firstCall = sandbox.teamHoursApply(); // starts, suspends on Alice's delayed save
    const secondCall = sandbox.teamHoursApply(); // should be ignored outright (in-flight guard)
    releaseFirstSave();
    await Promise.all([firstCall, secondCall]);
    const aliceSaves = calls.filter(function (c) { return c[0] === 'saveEmpHours' && c[1] === 'e1'; });
    const bobSaves = calls.filter(function (c) { return c[0] === 'saveEmpHours' && c[1] === 'e2'; });
    check('Alice written exactly once despite two overlapping Apply calls', aliceSaves.length, 1);
    check('Bob written exactly once despite two overlapping Apply calls', bobSaves.length, 1);
  }

  // Sequential double-tap (first call fully resolves before the second starts) still only writes once each --
  // i.e. a real second, distinct, deliberate tap after success is a NEW save, not a blocked one; this just
  // confirms the guard does not get stuck "true" and block all future taps.
  {
    const { sandbox, calls } = buildApplySandbox({ start: '09:00', end: '13:39', lunch: '0' });
    await sandbox.teamHoursApply();
    await sandbox.teamHoursApply();
    const aliceSaves = calls.filter(function (c) { return c[0] === 'saveEmpHours' && c[1] === 'e1'; });
    check('guard releases after completion -- a later, separate Apply still works', aliceSaves.length, 2);
  }

  // ── 2. Toast on success, none on failure ──
  {
    // team/date left at the fixture defaults (B1 / 2026-09-10) -- the
    // roster fixture only has employees on team B1, so a different team
    // here would leave zero eligible employees and bail out on the
    // (correct, pre-existing) "No employees to apply this to" validation
    // error before ever reaching the write loop or the toast.
    const { sandbox, toasts } = buildApplySandbox({ start: '09:00', end: '13:39', lunch: '0' });
    await sandbox.teamHoursApply();
    check('exactly one success toast shown', toasts.length, 1);
    check('toast is kind=success', toasts[0].kind, 'success');
    checkTrue('toast names the team', /B1/.test(toasts[0].msg));
    checkTrue('toast says "Hours saved"', /Hours saved/.test(toasts[0].msg));
  }
  {
    const { sandbox, toasts, els } = buildApplySandbox({ start: '09:00', end: '13:39', lunch: '0', saveFailsFor: 'e1' });
    await sandbox.teamHoursApply();
    check('no success toast on a failed save', toasts.length, 0);
    check('the existing visible error still shows', els['team-hours-error'].style.display, '');
  }
  {
    // Validation failure (inverted times) -- also no toast, existing error path unchanged.
    const { sandbox, toasts, calls } = buildApplySandbox({ start: '21:00', end: '16:27' });
    await sandbox.teamHoursApply();
    check('no toast and no writes on a validation failure', toasts.length, 0);
    check('no writes attempted', calls.some(function (c) { return c[0] === 'saveEmpHours'; }), false);
  }

  // ── 3. Card: Worked line only when an override exists; Scheduled unchanged either way ──
  {
    const { html } = buildCardSandbox({ overrides: {} });
    checkTrue('Scheduled line always present', /Scheduled 8h 30m/.test(html));
    check('no Worked line when no override exists for anyone on the team', /Worked/.test(html), false);
  }
  {
    const { html } = buildCardSandbox({ overrides: { e1: { hours: 4.7 }, e2: { hours: 4.7 } } });
    checkTrue('Scheduled line unchanged by the presence of overrides', /Scheduled 8h 30m/.test(html));
    checkTrue('Worked line appears, summed across the team (4.7 + 4.7 = 9.4h)', /Worked 9\.4h/.test(html));
  }
  {
    const { html } = buildCardSandbox({ overrides: { e1: { hours: 8 } } }); // only Alice has an override
    checkTrue('Scheduled line unchanged', /Scheduled 8h 30m/.test(html));
    checkTrue('Worked line reflects only the employees that actually have a saved override (8h, not 16h)', /Worked 8h/.test(html));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
