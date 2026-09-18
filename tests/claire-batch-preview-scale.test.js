// Bug report (Sept 2026, third report on this flow): Tom's real
// reproduction -- team S1, 8 dates x 4 employees = 32 entries -- hit
// MAX_TOOL_ROUNDS and never showed a preview. Tom asked explicitly:
// "does the preview builder actually work for 4 employees x 8 dates = 32
// previews? Or is it hitting some scale limit?"
//
// This test isolates that question from the OTHER half of the diagnosis
// (the LLM-side token budget -- see the max_tokens comment in
// processVoiceCommand and tests/claire-token-budget-and-round-cap-fallback
// .test.js) by exercising the real JS dispatcher branch directly, the same
// extraction technique as tests/claire-batch-edit-employee-hours.test.js,
// at Tom's exact 32-entry scale. If this fails, the bug is in the JS
// batch-resolution/write logic itself; if it passes (it does), the bug was
// entirely the 400-token voice-mode ceiling being too small for the
// tool_use call and its follow-up summary to fit -- confirmed separately
// by direct token-count measurement against the real CLAIRE_TOOLS schema.
//
// Run with: node tests/claire-batch-preview-scale.test.js

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

const dispatchSrc = 'async function _dispatch(name, input, message) {\n  if (false) {\n'
  + branchesSrc
  + '\n  }\n}';

// Team S1's real 4-employee roster (matches the live Manna Maids data
// checked via Supabase during the earlier round of this bug).
const S1_ROSTER = [
  { id: 'e_fatima', legacy_roster_id: 'e_fatima', uuid: 'uuid-fatima', name: 'Fatima Staff' },
  { id: 'e_franchesca', legacy_roster_id: 'e_franchesca', uuid: 'uuid-franchesca', name: 'Franchesca Lara' },
  { id: 'e_nadia', legacy_roster_id: 'e_nadia', uuid: 'uuid-nadia', name: 'Nadia Barros' },
  { id: 'e_natalia', legacy_roster_id: 'e_natalia', uuid: 'uuid-natalia', name: 'Natalia Fernandes' },
];
const DATES = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
const TIMES = [
  ['09:34', '18:37'], ['09:06', '18:10'], ['09:10', '19:22'], ['09:18', '15:51'],
  ['09:16', '19:39'], ['09:21', '18:11'], ['09:17', '18:31'], ['09:23', '17:31'],
];

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

function buildSandbox() {
  const calls = [];
  const savedByKey = {};
  const sandbox = {
    console,
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },
    findEmployeeWithSuggestions: findEmployeeWithSuggestionsMock(S1_ROSTER),
    getEmployeeTeam: function (empId, date) { return 'S1'; }, // everyone on S1, working, every day in range
    getEmployeeDayOffInfo: function () { return null; },
    getEmpHours: function (empId, date) { return savedByKey[empId + '_' + date] || null; },
    saveEmpHours: function (empId, date, data) {
      calls.push(['saveEmpHours', empId, date]);
      savedByKey[empId + '_' + date] = data;
      return Promise.resolve(data);
    },
    clearEmpHours: function (empId, date) { calls.push(['clearEmpHours', empId, date]); return Promise.resolve(); },
    calcHoursFromTimes: function (s, e, l) { return 8.5; },
    dateKey: function (d) { var dt = (d instanceof Date) ? d : new Date(d); return dt.toISOString().slice(0, 10); },
    _hrsFmt12: function (v) {
      if (!v) return '';
      var p = v.split(':'); var h = parseInt(p[0]), m = parseInt(p[1]);
      var ap = h >= 12 ? 'PM' : 'AM'; if (h > 12) h -= 12; if (h === 0) h = 12;
      return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
    },
    logPendingUpdate: function () { calls.push(['logPendingUpdate']); },
    _auditSupplement: function (actionType, entityType, entityId, newValues) {
      calls.push(['_auditSupplement', actionType, entityType, entityId, newValues]);
      return Promise.resolve();
    },
    claireReply: function (msg) { calls.push(['claireReply', msg]); },
    window: {
      supabaseClient: { from: function () { var chain = { eq: function () { return chain; }, maybeSingle: function () { return Promise.resolve({ data: null }); } }; return { select: function () { return chain; } }; } },
      PentaTenant: { current: function () { return 'biz-manna'; } },
      PentaEmployees: { getByLegacyRosterId: function (id) { var e = S1_ROSTER.find(function (r) { return r.legacy_roster_id === id; }); return e ? { id: e.uuid } : null; } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(dispatchSrc, sandbox);
  return { sandbox: sandbox, calls: calls, savedByKey: savedByKey };
}

function buildTomsEntries() {
  const entries = [];
  DATES.forEach(function (d, i) {
    S1_ROSTER.forEach(function (e) {
      entries.push({ employee: e.name, date: d, start: TIMES[i][0], end: TIMES[i][1], lunch: '10' });
    });
  });
  return entries;
}

async function main() {
  const entries = buildTomsEntries();
  check('reproduction builds exactly 32 entries (4 employees x 8 dates)', entries.length, 32);

  // ---- Preview at Tom's exact 32-entry scale: resolves everyone, no
  // truncation, no writes. ----
  {
    const { sandbox, calls } = buildSandbox();
    const t0 = Date.now();
    await sandbox._dispatch('batch_edit_employee_hours', { entries: entries });
    const elapsedMs = Date.now() - t0;
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('preview flag is set at 32-entry scale', result.preview, true);
    check('ALL 32 entries resolve and appear in the preview -- no silent truncation', result.changes.length, 32);
    check('every entry has both a current and proposed value', result.changes.every(function (c) { return typeof c.current === 'string' && typeof c.proposed === 'string'; }), true);
    check('preview performs NO writes at this scale', calls.some(function (c) { return c[0] === 'saveEmpHours'; }), false);
    check('32-entry preview resolves well within any reasonable timeout (no O(n^2)/hang)', elapsedMs < 2000, true);
  }

  // ---- Confirmed write at the same 32-entry scale: all 32 rows land,
  // 32 individual audit_log entries, nothing dropped. ----
  {
    const { sandbox, calls, savedByKey } = buildSandbox();
    await sandbox._dispatch('batch_edit_employee_hours', { entries: entries, confirmed: true });
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('batch reports success at 32-entry scale', result.success, true);
    check('all 32 entries counted', result.count, 32);
    const saveCalls = calls.filter(function (c) { return c[0] === 'saveEmpHours'; });
    check('exactly 32 rows written -- none dropped, none duplicated', saveCalls.length, 32);
    check('all 32 rows actually landed', Object.keys(savedByKey).length, 32);
    const auditCalls = calls.filter(function (c) { return c[0] === '_auditSupplement'; });
    check('32 individual audit_log entries, not one rolled-up entry', auditCalls.length, 32);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main();
