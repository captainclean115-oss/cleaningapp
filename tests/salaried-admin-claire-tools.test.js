// Salaried Admin/Office (follow-up to migration 113) -- Claire's three
// hours tools (get_employee_hours, edit_employee_hours,
// batch_edit_employee_hours) against the REAL extracted branches
// (contiguous else-if siblings inside _executeClaireToolCallInner,
// wrapped in a thin synthetic harness with `if (false) {}` prepended
// so the leading `} else if` parses standalone).
//
// Run with: node tests/salaried-admin-claire-tools.test.js

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

const branchesSrc = extract(
  "  } else if (name === 'get_employee_hours') {",
  "\n  } else if (name === 'locate_team') {",
  'get_employee_hours + edit_employee_hours + batch_edit_employee_hours branches'
);

const harnessSrc = `
async function runClaireTool(name, input, message) {
  if (false) {
${branchesSrc}
  }
}
`;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [
    { id: 'e1', name: 'Linda', uuid: 'u-linda', work_type: 'admin', pay_type: 'salary' },
    { id: 'e2', name: 'Pat', uuid: 'u-pat', work_type: 'admin', pay_type: 'hourly' },
    { id: 'e3', name: 'Alice', uuid: 'u-alice', work_type: 'field', pay_type: null, defaultTeam: 'B1' },
  ];
  const overrides = opts.overrides || {};
  const calls = [];
  const replies = [];
  const sandbox = {
    console,
    isSalariedAdmin: (emp) => emp && emp.work_type === 'admin' && emp.pay_type === 'salary',
    findEmployeeWithSuggestions: (q) => {
      const m = roster.filter((e) => e.name.toLowerCase() === (q || '').toLowerCase());
      return { matches: m, suggestions: m.length ? [] : roster.slice(0, 3) };
    },
    getEmpHours: (empId, dk) => (overrides[empId] && overrides[empId][dk]) || null,
    saveEmpHours: (empId, dk, data) => { calls.push(['saveEmpHours', empId, dk, data]); return Promise.resolve(); },
    clearEmpHours: (empId, dk) => { calls.push(['clearEmpHours', empId, dk]); return Promise.resolve(); },
    calcHoursFromTimes: (s, e, l) => 7.5,
    _hrsFmt12: (s) => s,
    _adminEmpDayOff: () => null,
    getEmployeeTeam: (empId, dk) => { const e = roster.find((r) => r.id === empId); return e ? (e.defaultTeam || null) : null; },
    getEmployeeDayOffInfo: () => null,
    DAY_OFF_CATEGORY_LABELS: {},
    _computeGpsHoursForDay: () => Promise.resolve({ available: false, reason: 'no GPS in this test' }),
    dateKey: (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d),
    claireReply: (msg) => { replies.push(msg); },
    window: { PentaEmployees: { getByLegacyRosterId: () => null } },
    _auditSupplement: () => Promise.resolve(),
    weekHours: undefined,
    hoursWeekOffset: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(harnessSrc, sandbox);
  return { sandbox, calls, replies };
}

async function main() {
  // ---- get_employee_hours: reports "salaried, no hours tracked" per date ----
  {
    const { sandbox } = buildSandbox();
    await sandbox.runClaireTool('get_employee_hours', { employee: 'Linda', date: '2026-10-08' }, null);
    check('get_employee_hours reports salaried status for Linda', /salaried, no hours tracked/i.test(sandbox._claireLastToolResult), true);
    check('no exception, no GPS/override lookup pretended to succeed', /Error/.test(sandbox._claireLastToolResult), false);
  }
  {
    // Pat (hourly admin) is unaffected -- still goes through the normal Admin/Office branch.
    const { sandbox } = buildSandbox({ overrides: { e2: { '2026-10-08': { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 } } } });
    await sandbox.runClaireTool('get_employee_hours', { employee: 'Pat', date: '2026-10-08' }, null);
    check('Pat (hourly admin) still gets a real manual_override report, not "salaried"', /manual_override/.test(sandbox._claireLastToolResult), true);
  }

  // ---- edit_employee_hours: hard refusal, no write ----
  {
    const { sandbox, calls, replies } = buildSandbox();
    await sandbox.runClaireTool('edit_employee_hours', { employee: 'Linda', date: '2026-10-08', start: '09:00', end: '17:00' }, null);
    check('edit_employee_hours never calls saveEmpHours for Linda', calls.some((c) => c[0] === 'saveEmpHours'), false);
    check('the refusal message names her and says salaried', /Linda is salaried, so there are no hours to edit/.test(sandbox._claireLastToolResult), true);
    check('claireReply is called with the same plain message', replies.some((r) => /Linda is salaried/.test(r)), true);
  }
  {
    // Alice (field, no pay_type at all) is unaffected -- the write still happens normally.
    const { sandbox, calls } = buildSandbox();
    await sandbox.runClaireTool('edit_employee_hours', { employee: 'Alice', date: '2026-10-08', start: '09:00', end: '17:00' }, null);
    check('edit_employee_hours still writes normally for a field employee', calls.some((c) => c[0] === 'saveEmpHours' && c[1] === 'e3'), true);
  }

  // ---- batch_edit_employee_hours: salaried entries are skipped (not an error), rest of the batch still previews ----
  {
    const { sandbox } = buildSandbox();
    await sandbox.runClaireTool('batch_edit_employee_hours', {
      entries: [
        { employee: 'Linda', date: '2026-10-08', start: '09:00', end: '17:00' },
        { employee: 'Alice', date: '2026-10-08', start: '08:00', end: '16:00' },
      ],
    }, null);
    const result = JSON.parse(sandbox._claireLastToolResult);
    check('the batch still previews (not an entry_resolution_failed abort)', result.error, undefined);
    check('Linda is listed as skipped, with a reason naming salaried/no hours', result.skipped.some((s) => s.employee === 'Linda' && /salaried/i.test(s.reason)), true);
    check('Alice still appears in the normal preview changes', result.changes.some((c) => c.employee === 'Alice'), true);
    check('Linda does NOT appear in the normal changes list (she was skipped, not resolved)', result.changes.some((c) => c.employee === 'Linda'), false);
  }

  // ---- batch_edit_employee_hours: confirmed=true never writes for the skipped salaried entry ----
  {
    const { sandbox, calls } = buildSandbox();
    await sandbox.runClaireTool('batch_edit_employee_hours', {
      confirmed: true,
      entries: [
        { employee: 'Linda', date: '2026-10-08', start: '09:00', end: '17:00' },
        { employee: 'Alice', date: '2026-10-08', start: '08:00', end: '16:00' },
      ],
    }, null);
    check('saveEmpHours is called for Alice', calls.some((c) => c[0] === 'saveEmpHours' && c[1] === 'e3'), true);
    check('saveEmpHours is NEVER called for Linda, even with confirmed=true', calls.some((c) => c[0] === 'saveEmpHours' && c[1] === 'e1'), false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
