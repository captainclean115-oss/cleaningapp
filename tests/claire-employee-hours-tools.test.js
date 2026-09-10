// Tom: "Claire needs full read and write access to employee hours."
// Real workflow: "Claire, make Natalia's hours match Nadia's from last
// week - copy start and end times."
//
// Builds get_employee_hours (new) and extends edit_employee_hours
// (name disambiguation via findEmployeeWithSuggestions instead of
// first-match-wins, an explicit source='claire' audit_log row, and
// read-back verification before reporting success). This test extracts
// BOTH real dispatcher branches verbatim from index.html (the
// enclosing _executeClaireToolCallInner is a multi-thousand-line
// dispatcher, not practical to run wholesale -- same reasoning as
// tests/claire-edit-employee-hours-awaits-save.test.js) and runs each
// branch, wrapped in a thin async function so `await` inside them is
// valid, with comprehensive mocks at the true I/O boundaries (Supabase
// client, PentaEmployees/PentaTenant; the GPS/override helpers
// themselves already have their own dedicated tests elsewhere).
//
// Run with: node tests/claire-employee-hours-tools.test.js

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
// Wrap the two branches (get_employee_hours, edit_employee_hours) in a
// thin async function so `await` inside them is valid outside the real
// dispatcher. The slice starts with a dangling "}" (closes whatever
// branch precedes it in the real file) -- pair it with a bogus
// `if (false) {` so the else-if chain continues validly, then close
// the last branch's block and the wrapper function ourselves.
const branchesSrc = 'async function _dispatch(name, input, message) {\n  if (false) {\n'
  + src.slice(startIdx, endIdx)
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
  const roster = opts.roster || [{ id: 'e_nadia', legacy_roster_id: 'e_nadia', uuid: 'uuid-nadia', name: 'Nadia Silva' }];
  const overridesByKey = opts.overridesByKey || {};
  const teamByKey = opts.teamByKey || {};
  const offByKey = opts.offByKey || {};
  const gpsByTeamDate = opts.gpsByTeamDate || {};
  let savedRow = opts.savedRow || null; // what the read-back verification query returns
  const sandbox = {
    console,
    weekHours: opts.weekHours || {},
    hoursWeekOffset: 0,
    jobs: [],
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation', unexcused_absence: 'Unexcused absence' },
    findEmployeeWithSuggestions: findEmployeeWithSuggestionsMock(roster),
    getEmployeeTeam: function (empId, date) {
      var k = empId + '_' + date;
      return Object.prototype.hasOwnProperty.call(teamByKey, k) ? teamByKey[k] : 'B3';
    },
    getEmployeeDayOffInfo: function (empId, date) { return offByKey[empId + '_' + date] || null; },
    getEmpHours: function (empId, date) { return overridesByKey[empId + '_' + date] || null; },
    saveEmpHours: function (empId, date, data) {
      calls.push(['saveEmpHours', empId, date, data]);
      if (opts.saveThrows) return Promise.reject(new Error('write failed'));
      savedRow = { start_time: data.start || null, end_time: data.end || null, lunch_minutes: data.lunch != null ? data.lunch : null, hours: data.hours != null ? data.hours : null };
      return Promise.resolve(savedRow);
    },
    calcHoursFromTimes: function (s, e, l) { return 7.5; },
    dateKey: function (d) { var dt = (d instanceof Date) ? d : new Date(d); return dt.toISOString().slice(0, 10); },
    _hrsFmt12: function (v) { return typeof v === 'string' ? v : (v ? 'FMT(' + v.toISOString() + ')' : ''); },
    _computeGpsHoursForDay: function (team, date) {
      calls.push(['_computeGpsHoursForDay', team, date]);
      var key = team + '_' + date;
      return Promise.resolve(gpsByTeamDate[key] || { available: false, reason: 'No GPS trips recorded' });
    },
    getWeekDates: function () { return [new Date('2026-08-31'), new Date('2026-09-01'), new Date('2026-09-02'), new Date('2026-09-03'), new Date('2026-09-04')]; },
    _writeWeekHoursCache: function () { calls.push(['_writeWeekHoursCache']); },
    logPendingUpdate: function (a, b) { calls.push(['logPendingUpdate', a, b]); },
    _auditSupplement: function (actionType, entityType, entityId, newValues) {
      calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    },
    claireReply: function (msg) { calls.push(['claireReply', msg]); },
    window: {
      supabaseClient: {
        from: function () {
          var chain = {
            eq: function () { return chain; },
            maybeSingle: function () { return Promise.resolve({ data: opts.readBackFails ? null : savedRow }); },
          };
          return { select: function () { return chain; } };
        }
      },
      PentaTenant: { current: function () { return 'biz-1'; } },
      PentaEmployees: { getByLegacyRosterId: function (id) { var e = roster.find(function (r) { return r.legacy_roster_id === id; }); return e ? { id: e.uuid } : null; } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(branchesSrc, sandbox);
  return { sandbox, calls, getSavedRow: function () { return savedRow; } };
}

async function main() {
  // ============ get_employee_hours ============

  // ---- Single date, GPS-sourced (no override, not off) ----
  {
    const { sandbox, calls } = buildSandbox({
      gpsByTeamDate: { 'B3_2026-09-01': { available: true, start: new Date('2026-09-01T13:15:00Z'), end: new Date('2026-09-01T21:22:00Z'), lunchMin: 10, hours: 7.9 } },
    });
    await sandbox._dispatch('get_employee_hours', { employee: 'Nadia', date: '2026-09-01' });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('employee name resolved', result.employee, 'Nadia Silva');
    check('one day returned', result.days.length, 1);
    check('source is gps', result.days[0].source, 'gps');
    check('lunch minutes carried through', result.days[0].lunch_minutes, 10);
    check('total_hours rounded', result.days[0].total_hours, 7.9);
    check('team_that_day present', result.days[0].team_that_day, 'B3');
  }

  // ---- Manual override takes precedence over GPS ----
  {
    const { sandbox } = buildSandbox({
      overridesByKey: { 'e_nadia_2026-09-01': { start: '09:15', end: '17:20', lunch: 30, hours: 7.9 } },
      gpsByTeamDate: { 'B3_2026-09-01': { available: true, start: new Date(), end: new Date(), lunchMin: 999, hours: 1 } },
    });
    await sandbox._dispatch('get_employee_hours', { employee: 'Nadia', date: '2026-09-01' });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('an existing override wins over GPS', result.days[0].source, 'manual_override');
    check('override lunch value used, not the GPS one', result.days[0].lunch_minutes, 30);
  }

  // ---- Day off ----
  {
    const { sandbox } = buildSandbox({
      teamByKey: { 'e_nadia_2026-09-02': null },
      offByKey: { 'e_nadia_2026-09-02': { status_type: 'vacation' } },
    });
    await sandbox._dispatch('get_employee_hours', { employee: 'Nadia', date: '2026-09-02' });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('off status reported with the real category label', result.days[0], { date: '2026-09-02', day_of_week: result.days[0].day_of_week, status: 'off', reason: 'Vacation' });
  }

  // ---- Date range (from/to) returns one entry per day ----
  {
    const { sandbox } = buildSandbox({
      gpsByTeamDate: {
        'B3_2026-09-01': { available: true, start: new Date(), end: new Date(), lunchMin: 0, hours: 8 },
        'B3_2026-09-02': { available: true, start: new Date(), end: new Date(), lunchMin: 0, hours: 8 },
        'B3_2026-09-03': { available: true, start: new Date(), end: new Date(), lunchMin: 0, hours: 8 },
      },
    });
    await sandbox._dispatch('get_employee_hours', { employee: 'Nadia', from: '2026-09-01', to: '2026-09-03' });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('a from/to range returns one entry per day, inclusive', result.days.map(function (d) { return d.date; }), ['2026-09-01', '2026-09-02', '2026-09-03']);
  }

  // ---- Ambiguous employee name -- must ask, never silently pick one ----
  {
    const roster = [
      { id: 'e_maria1', legacy_roster_id: 'e_maria1', uuid: 'uuid-1', name: 'Maria Vieira' },
      { id: 'e_maria2', legacy_roster_id: 'e_maria2', uuid: 'uuid-2', name: 'Maria Rodriguez' },
    ];
    const { sandbox, calls } = buildSandbox({ roster: roster });
    await sandbox._dispatch('get_employee_hours', { employee: 'Maria', date: '2026-09-01' });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('ambiguous_employee error is returned', result.error, 'ambiguous_employee');
    check('candidates list both Marias', result.candidates.map(function (c) { return c.name; }).sort(), ['Maria Rodriguez', 'Maria Vieira']);
    check('claireReply is never called for the ambiguous case (lets the LLM round handle it)', calls.some(function (c) { return c[0] === 'claireReply'; }), false);
  }

  // ---- Employee not found ----
  {
    const { sandbox } = buildSandbox({});
    await sandbox._dispatch('get_employee_hours', { employee: 'Zzzznonexistent', date: '2026-09-01' });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('employee_not_found error is returned', result.error, 'employee_not_found');
  }

  // ============ edit_employee_hours ============

  // ---- Happy path: save succeeds, read-back verifies, audit log has source=claire ----
  {
    const { sandbox, calls } = buildSandbox({});
    await sandbox._dispatch('edit_employee_hours', { employee: 'Nadia', date: '2026-09-01', start: '09:15', end: '17:20', lunch: '30' });
    check('saveEmpHours was called with the right values', calls.some(function (c) { return c[0] === 'saveEmpHours' && c[3].start === '09:15' && c[3].end === '17:20'; }), true);
    const auditCall = calls.find(function (c) { return c[0] === '_auditSupplement'; });
    check('an audit_log supplement is written', !!auditCall, true);
    check('action_type is manual_override, entity_type is employee', [auditCall[1], auditCall[2]], ['manual_override', 'employee']);
    check('the audit new_values carries source=claire', auditCall[4].source, 'claire');
    check('the audit new_values carries the actual edit', [auditCall[4].date, auditCall[4].start, auditCall[4].end], ['2026-09-01', '09:15', '17:20']);
    check('logPendingUpdate still runs (manager-facing audit trail)', calls.some(function (c) { return c[0] === 'logPendingUpdate'; }), true);
    check('the final result mentions verification', /verified/i.test(sandbox._claireLastToolResult), true);
  }

  // ---- Lunch-only edit: verification must check the lunch value
  // itself, not just "a row exists" (a row could exist with a stale
  // lunch value from a prior edit while start/end are untouched). ----
  {
    const { sandbox, calls } = buildSandbox({ overridesByKey: { 'e_nadia_2026-09-01': { start: '09:15', end: '17:20', lunch: 0, hours: 8 } } });
    await sandbox._dispatch('edit_employee_hours', { employee: 'Nadia', date: '2026-09-01', lunch: '30' });
    check('lunch-only edit is verified successfully when the row reflects the new lunch value', /verified/i.test(sandbox._claireLastToolResult), true);
    const auditCall = calls.find(function (c) { return c[0] === '_auditSupplement'; });
    check('the audit trail records the lunch-only change', auditCall[4].lunch, 30);
  }

  // ---- Read-back verification fails (row not found after "successful" write) ----
  {
    const { sandbox, calls } = buildSandbox({ readBackFails: true });
    await sandbox._dispatch('edit_employee_hours', { employee: 'Nadia', date: '2026-09-01', start: '09:15', end: '17:20' });
    check('a "could not verify" message is surfaced, not a false success', /could not verify/i.test(sandbox._claireLastToolResult), true);
    check('no audit_log supplement is written when verification fails', calls.some(function (c) { return c[0] === '_auditSupplement'; }), false);
  }

  // ---- Save itself fails -- must not claim success or attempt verification ----
  {
    const { sandbox, calls } = buildSandbox({ saveThrows: true });
    await sandbox._dispatch('edit_employee_hours', { employee: 'Nadia', date: '2026-09-01', start: '09:15', end: '17:20' });
    check('a "could not save" message is surfaced', /could not save/i.test(sandbox._claireLastToolResult), true);
    check('no audit_log supplement when the save itself failed', calls.some(function (c) { return c[0] === '_auditSupplement'; }), false);
  }

  // ---- Ambiguous employee on the WRITE path too -- must never guess ----
  {
    const roster = [
      { id: 'e_maria1', legacy_roster_id: 'e_maria1', uuid: 'uuid-1', name: 'Maria Vieira' },
      { id: 'e_maria2', legacy_roster_id: 'e_maria2', uuid: 'uuid-2', name: 'Maria Rodriguez' },
    ];
    const { sandbox, calls } = buildSandbox({ roster: roster });
    await sandbox._dispatch('edit_employee_hours', { employee: 'Maria', date: '2026-09-01', start: '09:00', end: '17:00' });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('ambiguous_employee blocks the write entirely', result.error, 'ambiguous_employee');
    check('saveEmpHours is never called when the employee is ambiguous', calls.some(function (c) { return c[0] === 'saveEmpHours'; }), false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
