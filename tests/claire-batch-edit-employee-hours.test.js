// Tom (follow-up to the "Claire seems stuck/limited" report, after the
// findEmployees false-ambiguity fix): explicitly asked for a batch hours
// tool alongside the existing one-employee/one-date edit_employee_hours,
// with these hard safety requirements:
//   1. Single-edit behavior stays unchanged.
//   2. Batch = multiple employees same date, OR one employee multiple
//      dates, OR combinations.
//   3. A preview showing the FULL list (current -> proposed) must happen
//      BEFORE any write, and Tom must explicitly confirm the whole batch.
//   4. "skip <name>" removes that entry and re-previews -- no write until
//      the (possibly shorter) final list is confirmed.
//   5. Individual audit_log entries per edit, not one rolled-up entry.
//   6. All-or-nothing: a failure partway through rolls back everything
//      already written in that call and reports clearly what happened.
//
// Implements a new batch_edit_employee_hours tool with a two-phase
// confirmed-flag protocol (preview when omitted/false, write when true).
// This test extracts the real dispatcher branches verbatim from
// index.html (get_employee_hours through batch_edit_employee_hours, up
// to locate_team) -- same extraction technique as
// tests/claire-employee-hours-tools.test.js -- and exercises the batch
// branch specifically, with the single-edit branch left untouched
// alongside it to prove the two coexist correctly in the same dispatcher
// slice.
//
// Run with: node tests/claire-batch-edit-employee-hours.test.js

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

const startMarker = "} else if (name === 'get_employee_hours') {";
const endMarker = "} else if (name === 'locate_team') {";
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find get_employee_hours branch'); process.exit(1); }
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find end boundary (locate_team branch)'); process.exit(1); }
const branchesSrc = src.slice(startIdx, endIdx);

if (branchesSrc.indexOf("name === 'batch_edit_employee_hours'") === -1) {
  console.error('FAIL: batch_edit_employee_hours branch not found between get_employee_hours and locate_team -- fix may have been reverted or moved.');
  process.exit(1);
}

const dispatchSrc = 'async function _dispatch(name, input, message) {\n  if (false) {\n'
  + branchesSrc
  + '\n  }\n}';

function findEmployeeWithSuggestionsMock(roster) {
  return function (query) {
    var q = String(query || '').toLowerCase().trim();
    var exact = roster.filter(function (e) { return e.name.toLowerCase() === q; });
    if (exact.length) return { matches: exact, suggestions: [] };
    var subset = roster.filter(function (e) { return e.name.toLowerCase().indexOf(q) !== -1; });
    if (subset.length) return { matches: subset, suggestions: [] };
    return { matches: [], suggestions: roster.slice(0, 3) };
  };
}

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const roster = opts.roster || [
    { id: 'e_katia', legacy_roster_id: 'e_katia', uuid: 'uuid-katia', name: 'Katia Mejia' },
    { id: 'e_elvia', legacy_roster_id: 'e_elvia', uuid: 'uuid-elvia', name: 'Elvia Tonato' },
    { id: 'e_nadia', legacy_roster_id: 'e_nadia', uuid: 'uuid-nadia', name: 'Nadia Silva' },
    { id: 'e_ana', legacy_roster_id: 'e_ana', uuid: 'uuid-ana', name: 'Ana Souza' },
    { id: 'e_luz', legacy_roster_id: 'e_luz', uuid: 'uuid-luz', name: 'Luz Ramirez' },
  ];
  const overridesByKey = opts.overridesByKey || {};
  const teamByKey = opts.teamByKey || {};
  const offByKey = opts.offByKey || {};
  const savedByKey = Object.assign({}, overridesByKey);
  const sandbox = {
    console,
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation', unexcused_absence: 'Unexcused absence' },
    findEmployeeWithSuggestions: findEmployeeWithSuggestionsMock(roster),
    getEmployeeTeam: function (empId, date) {
      var k = empId + '_' + date;
      return Object.prototype.hasOwnProperty.call(teamByKey, k) ? teamByKey[k] : 'B3';
    },
    getEmployeeDayOffInfo: function (empId, date) { return offByKey[empId + '_' + date] || null; },
    getEmpHours: function (empId, date) { return savedByKey[empId + '_' + date] || null; },
    saveEmpHours: function (empId, date, data) {
      calls.push(['saveEmpHours', empId, date, JSON.parse(JSON.stringify(data))]);
      var key = empId + '_' + date;
      if (opts.failOn && opts.failOn(empId, date, calls.filter(function(c){return c[0]==='saveEmpHours';}).length)) {
        return Promise.reject(new Error('write failed for ' + empId + ' on ' + date));
      }
      savedByKey[key] = data;
      return Promise.resolve(data);
    },
    clearEmpHours: function (empId, date) {
      calls.push(['clearEmpHours', empId, date]);
      delete savedByKey[empId + '_' + date];
      return Promise.resolve();
    },
    calcHoursFromTimes: function (s, e, l) { return 7.5; },
    dateKey: function (d) { var dt = (d instanceof Date) ? d : new Date(d); return dt.toISOString().slice(0, 10); },
    _hrsFmt12: function (v) {
      if (!v) return '';
      if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) {
        var p = v.split(':'); var h = parseInt(p[0]), m = parseInt(p[1]);
        var ap = h >= 12 ? 'PM' : 'AM'; if (h > 12) h -= 12; if (h === 0) h = 12;
        return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
      }
      return String(v);
    },
    logPendingUpdate: function (a, b) { calls.push(['logPendingUpdate', a, b]); },
    _auditSupplement: function (actionType, entityType, entityId, newValues) {
      calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    },
    claireReply: function (msg) { calls.push(['claireReply', msg]); },
    window: {
      supabaseClient: { from: function () { var chain = { eq: function () { return chain; }, maybeSingle: function () { return Promise.resolve({ data: null }); } }; return { select: function () { return chain; } }; } },
      PentaTenant: { current: function () { return 'biz-1'; } },
      PentaEmployees: { getByLegacyRosterId: function (id) { var e = roster.find(function (r) { return r.legacy_roster_id === id; }); return e ? { id: e.uuid } : null; } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(dispatchSrc, sandbox);
  return { sandbox: sandbox, calls: calls, savedByKey: savedByKey };
}

async function main() {
  // ---- Preview (confirmed omitted): resolves everyone, shows current ->
  // proposed, writes NOTHING. ----
  {
    const { sandbox, calls } = buildSandbox({
      overridesByKey: { 'e_elvia_2026-09-02': { start: '08:32', end: '16:15', lunch: 30, hours: 7.2 } },
      teamByKey: { 'e_katia_2026-09-02': null }, // Katia is OFF that day
      offByKey: { 'e_katia_2026-09-02': { status_type: 'vacation' } },
    });
    await sandbox._dispatch('batch_edit_employee_hours', {
      entries: [
        { employee: 'Katia', date: '2026-09-02', start: '09:00', end: '17:00' },
        { employee: 'Elvia', date: '2026-09-02', start: '09:00', end: '17:00' },
      ]
    });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('preview flag is set', result.preview, true);
    check('preview lists both entries', result.changes.length, 2);
    check('Katia\'s current status shows OFF with category', result.changes[0].current, 'OFF (Vacation)');
    check('Elvia\'s current value shows her real prior hours', result.changes[1].current, '8:32 AM - 4:15 PM');
    check('both proposed values show the new time range', result.changes.map(function(c){return c.proposed;}), ['9:00 AM - 5:00 PM', '9:00 AM - 5:00 PM']);
    check('preview performs NO writes', calls.some(function (c) { return c[0] === 'saveEmpHours'; }), false);
  }

  // ---- Confirmed batch of 5: writes 5 rows, 5 individual audit_log
  // entries (not one rolled-up entry). ----
  {
    const { sandbox, calls, savedByKey } = buildSandbox({});
    const entries = ['Katia', 'Elvia', 'Nadia', 'Ana', 'Luz'].map(function (n) {
      return { employee: n, date: '2026-09-02', start: '09:00', end: '17:00' };
    });
    await sandbox._dispatch('batch_edit_employee_hours', { entries: entries, confirmed: true });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('batch reports success', result.success, true);
    check('all 5 entries counted', result.count, 5);
    const saveCalls = calls.filter(function (c) { return c[0] === 'saveEmpHours'; });
    check('exactly 5 rows written', saveCalls.length, 5);
    const auditCalls = calls.filter(function (c) { return c[0] === '_auditSupplement'; });
    check('exactly 5 individual audit_log entries -- not one rolled-up batch entry', auditCalls.length, 5);
    check('every audit entry is tagged source=claire and batch=true', auditCalls.every(function (c) { return c[4].source === 'claire' && c[4].batch === true; }), true);
    check('all 5 rows actually landed with the new times', Object.keys(savedByKey).length, 5);
  }

  // ---- entry_resolution_failed: ANY unresolved entry bails the WHOLE
  // call -- no partial preview, no partial write. ----
  {
    const { sandbox, calls } = buildSandbox({});
    await sandbox._dispatch('batch_edit_employee_hours', {
      entries: [
        { employee: 'Katia', date: '2026-09-02', start: '09:00', end: '17:00' },
        { employee: 'Zzzznobody', date: '2026-09-02', start: '09:00', end: '17:00' },
      ]
    });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('reports entry_resolution_failed', result.error, 'entry_resolution_failed');
    check('the failing entry is identified', result.errors[0].employee, 'Zzzznobody');
    check('nothing is written when an entry fails to resolve', calls.some(function (c) { return c[0] === 'saveEmpHours'; }), false);
  }

  // ---- "Skip" behavior: dropping an entry from the list and previewing
  // again shows only the remaining people -- mechanically, this is just
  // calling with a shorter entries array, matching the system-prompt
  // instruction to re-preview after a skip instead of writing partway. ----
  {
    const { sandbox } = buildSandbox({});
    const full = [
      { employee: 'Katia', date: '2026-09-02', start: '09:00', end: '17:00' },
      { employee: 'Elvia', date: '2026-09-02', start: '09:00', end: '17:00' },
      { employee: 'Nadia', date: '2026-09-02', start: '09:00', end: '17:00' },
    ];
    await sandbox._dispatch('batch_edit_employee_hours', { entries: full });
    const firstPreview = JSON.parse(sandbox._claireLastToolResult);
    check('initial preview lists all 3', firstPreview.changes.map(function(c){return c.employee;}), ['Katia Mejia', 'Elvia Tonato', 'Nadia Silva']);

    const afterSkip = full.filter(function (e) { return e.employee !== 'Elvia'; });
    await sandbox._dispatch('batch_edit_employee_hours', { entries: afterSkip });
    const secondPreview = JSON.parse(sandbox._claireLastToolResult);
    check('after skipping Elvia, the re-preview no longer lists her', secondPreview.changes.map(function(c){return c.employee;}), ['Katia Mejia', 'Nadia Silva']);
    check('skip re-preview still performs no writes', secondPreview.preview, true);
  }

  // ---- Failure partway through: everything already written in THIS
  // call rolls back to its exact prior state, and the response says
  // plainly what happened -- never implies full success. ----
  {
    const { sandbox, calls, savedByKey } = buildSandbox({
      overridesByKey: { 'e_elvia_2026-09-02': { start: '08:00', end: '16:00', lunch: 30, hours: 7.5 } }, // Elvia HAD a prior override
      // Katia had none -- rollback for her must mean "no override", not a fabricated one.
      failOn: function (empId, date, nthSaveCall) { return empId === 'e_nadia'; }, // 3rd employee in the batch fails
    });
    const entries = [
      { employee: 'Katia', date: '2026-09-02', start: '09:00', end: '17:00' },
      { employee: 'Elvia', date: '2026-09-02', start: '09:00', end: '17:00' },
      { employee: 'Nadia', date: '2026-09-02', start: '09:00', end: '17:00' }, // this one fails
      { employee: 'Ana', date: '2026-09-02', start: '09:00', end: '17:00' },
    ];
    await sandbox._dispatch('batch_edit_employee_hours', { entries: entries, confirmed: true });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('reports batch_write_failed, not success', result.error, 'batch_write_failed');
    check('identifies exactly who/what failed', result.failed_at.employee, 'Nadia Silva');
    check('reports 2 entries were written before the failure (Katia, Elvia)', result.written_before_failure, 2);
    check('Ana (after the failure point) was never attempted', calls.some(function (c) { return c[0] === 'saveEmpHours' && c[1] === 'e_ana'; }), false);
    check('both already-applied entries were rolled back', result.rolled_back.sort(), ['Elvia Tonato', 'Katia Mejia'].sort());
    check('Katia (no prior override) is rolled back via clearEmpHours, not left with a fabricated one', calls.some(function (c) { return c[0] === 'clearEmpHours' && c[1] === 'e_katia'; }), true);
    check('Katia has no override after rollback', savedByKey['e_katia_2026-09-02'], undefined);
    check('Elvia (had a prior override) is restored to her EXACT prior value, not cleared', savedByKey['e_elvia_2026-09-02'], { start: '08:00', end: '16:00', lunch: 30, hours: 7.5 });
    check('the reply does not claim the batch succeeded', /rolled back/i.test(sandbox._claireLastToolResult) || calls.some(function(c){ return c[0]==='claireReply' && /rolled back/i.test(c[1]); }), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
