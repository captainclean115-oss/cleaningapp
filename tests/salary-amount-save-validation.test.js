// Salary amount/period (migration 114 follow-up) -- two things,
// against the REAL extracted code (not reimplementations):
//   1. saveStaffEmployee's Save-time validation block: blocks the save
//      with a visible alert for an invalid amount, an amount with no
//      period, or a period with no amount; allows both blank; calls
//      the isolated write with the right validated values otherwise.
//      Uses the REAL _parseSalaryAmountInput (extracted alongside it),
//      not a mock, so this exercises the actual integration.
//   2. _staffSaveSalaryFields in isolation: no-ops when nothing
//      changed, writes + audits when something did, and surfaces a
//      visible alert (never a silent failure) if the write itself
//      throws -- e.g. the migration 114 columns not existing yet.
//
// Run with: node tests/salary-amount-save-validation.test.js

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

const parseSrc = extract(
  'function _parseSalaryAmountInput(raw) {',
  '\n\n// Nicely-formatted display string',
  '_parseSalaryAmountInput'
);
const salaryWriteSrc = extract(
  'async function _staffSaveSalaryFields(supaRowId, employeeName, oldAmount, oldPeriod, newAmount, newPeriod) {',
  '\n\nasync function saveStaffEmployee() {',
  '_staffSaveSalaryFields'
);
const saveSrc = extract(
  'async function saveStaffEmployee() {',
  '\n\nasync function deleteStaffEmployee() {',
  'saveStaffEmployee'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ───────────────────────── Part 1: _staffSaveSalaryFields ─────────────────────────
function buildWriteSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const alerts = [];
  const sandbox = {
    console,
    alert: (msg) => alerts.push(msg),
    window: {
      PentaEmployees: opts.noPentaEmployees ? undefined : {
        update: (id, patch) => {
          calls.push(['PentaEmployees.update', id, patch]);
          if (opts.updateThrows) return Promise.reject(new Error(opts.updateThrows));
          return Promise.resolve({});
        },
      },
    },
    _auditSupplement: (action_type, entity_type, entity_id, new_values) => {
      calls.push(['_auditSupplement', action_type, entity_type, entity_id, new_values]);
      return Promise.resolve();
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(salaryWriteSrc, sandbox);
  return { sandbox, calls, alerts };
}

async function testSalaryWrite() {
  // ---- No-op when nothing changed: no write, no audit ----
  {
    const { sandbox, calls } = buildWriteSandbox();
    await sandbox._staffSaveSalaryFields('uuid-1', 'Linda', 13000, 'month', 13000, 'month');
    check('unchanged amount+period writes nothing', calls.length, 0);
  }
  // ---- Going from unset to set: writes + audits with correct old/new ----
  {
    const { sandbox, calls } = buildWriteSandbox();
    await sandbox._staffSaveSalaryFields('uuid-1', 'Linda', null, null, 13000, 'month');
    const upd = calls.find((c) => c[0] === 'PentaEmployees.update');
    check('the real write targets the right employee id', upd && upd[1], 'uuid-1');
    check('the real write sends exactly salary_amount + salary_period', upd && upd[2], { salary_amount: 13000, salary_period: 'month' });
    const aud = calls.find((c) => c[0] === '_auditSupplement');
    check('an audit_log row is written with source=staff_salary_edit', aud && aud[4].source, 'staff_salary_edit');
    check('the audit row carries the old (null) and new amount', aud && [aud[4].old_salary_amount, aud[4].new_salary_amount], [null, 13000]);
    check('the audit row carries the old (null) and new period', aud && [aud[4].old_salary_period, aud[4].new_salary_period], [null, 'month']);
    check('the audit action_type is the generic "updated" (no dedicated action_type exists for this)', aud && aud[1], 'updated');
    check('the audit entity_type is "employee"', aud && aud[2], 'employee');
    check('the audit entity_id is the employee uuid', aud && aud[3], 'uuid-1');
  }
  // ---- Clearing a previously-set value (both blank is allowed) ----
  {
    const { sandbox, calls } = buildWriteSandbox();
    await sandbox._staffSaveSalaryFields('uuid-1', 'Linda', 13000, 'month', null, null);
    const upd = calls.find((c) => c[0] === 'PentaEmployees.update');
    check('clearing both fields writes explicit nulls (not skipped)', upd && upd[2], { salary_amount: null, salary_period: null });
  }
  // ---- Write failure (e.g. migration 114 not applied yet): visible alert, never silent ----
  {
    const { sandbox, alerts, calls } = buildWriteSandbox({ updateThrows: "column employees.salary_amount does not exist" });
    await sandbox._staffSaveSalaryFields('uuid-1', 'Linda', null, null, 13000, 'month');
    check('a failed write produces a visible alert naming the employee', alerts.some((a) => /Linda/.test(a)), true);
    check('the alert surfaces the real underlying error', alerts.some((a) => /salary_amount does not exist/.test(a)), true);
    check('the alert reassures the rest of the save still went through', alerts.some((a) => /Everything else/.test(a)), true);
    check('no audit row is written when the write itself failed', calls.some((c) => c[0] === '_auditSupplement'), false);
  }
  // ---- PentaEmployees unavailable: still a visible alert, not a crash ----
  {
    const { sandbox, alerts } = buildWriteSandbox({ noPentaEmployees: true });
    await sandbox._staffSaveSalaryFields('uuid-1', 'Linda', null, null, 13000, 'month');
    check('a missing PentaEmployees facade produces a visible alert, not an uncaught throw', alerts.length, 1);
  }
}

// ───────────────────────── Part 2: saveStaffEmployee's validation ─────────────────────────
function defaultEl() { return { value: '', checked: false, files: [] }; }

function buildSaveSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const alerts = [];
  const confirms = [];
  const elCache = {};
  const overrides = opts.els || {};
  function getElementById(id) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
    if (!elCache[id]) elCache[id] = defaultEl();
    return elCache[id];
  }
  const staffList = opts.staffList || [{ id: 'uuid-linda', legacy_roster_id: 'e1', business_id: 'biz-1', name: 'Linda Smith', work_type: 'admin', pay_type: 'hourly' }];

  const sandbox = {
    console,
    alert: (msg) => alerts.push(msg),
    confirm: (msg) => { confirms.push(msg); return true; },
    setTimeout: (fn) => fn(),
    document: { getElementById },
    window: {
      supabaseClient: null, PentaAuth: null,
      PentaTeams: { getById: () => null },
      PentaEmployees: {
        list: () => Promise.resolve(staffList),
        listSync: () => staffList,
        insert: (row) => { calls.push(['PentaEmployees.insert', row]); return Promise.resolve(row); },
        update: (id, patch) => { calls.push(['PentaEmployees.update', id, patch]); return Promise.resolve({}); },
      },
    },
    getStaffList: () => staffList,
    switchEmployeeWorkType: () => { calls.push(['switchEmployeeWorkType']); return Promise.resolve({ removedCount: 0 }); },
    closeStaffModal: () => calls.push(['closeStaffModal']),
    renderStaffList: () => calls.push(['renderStaffList']),
    _staffSaveSalaryFields: (id, name, oldAmt, oldPer, newAmt, newPer) => {
      calls.push(['_staffSaveSalaryFields', id, oldAmt, oldPer, newAmt, newPer]);
      return Promise.resolve();
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(parseSrc, sandbox);
  vm.runInContext(saveSrc, sandbox);
  return { sandbox, calls, alerts, confirms };
}

async function testSaveValidation() {
  const baseEls = () => ({
    'staff-edit-idx': { value: '0' },
    'staff-first-name': { value: 'Linda' },
    'staff-last-name': { value: 'Smith' },
    'staff-work-type': { value: 'admin' },
    'staff-pay-type': { value: 'salary' },
    'staff-team': { value: '' },
  });

  // ---- Amount with no period: blocked, visible message, no write ----
  {
    const els = baseEls();
    els['staff-salary-amount'] = { value: '13000' };
    els['staff-salary-period'] = { value: '' };
    const { sandbox, calls, alerts } = buildSaveSandbox({ els });
    await sandbox.saveStaffEmployee();
    check('amount-without-period blocks the save entirely', calls.some((c) => c[0] === 'PentaEmployees.update'), false);
    check('a clear message explains the amount/period mismatch', alerts.some((a) => /didn't choose a pay period/.test(a)), true);
  }

  // ---- Period with no amount: blocked, visible message, no write ----
  {
    const els = baseEls();
    els['staff-salary-amount'] = { value: '' };
    els['staff-salary-period'] = { value: 'month' };
    const { sandbox, calls, alerts } = buildSaveSandbox({ els });
    await sandbox.saveStaffEmployee();
    check('period-without-amount blocks the save entirely', calls.some((c) => c[0] === 'PentaEmployees.update'), false);
    check('a clear message explains the period/amount mismatch', alerts.some((a) => /didn't enter a salary amount/.test(a)), true);
  }

  // ---- Invalid (non-numeric) amount: blocked with the parser's own message ----
  {
    const els = baseEls();
    els['staff-salary-amount'] = { value: 'thirteen grand' };
    els['staff-salary-period'] = { value: 'month' };
    const { sandbox, calls, alerts } = buildSaveSandbox({ els });
    await sandbox.saveStaffEmployee();
    check('a non-numeric amount blocks the save', calls.some((c) => c[0] === 'PentaEmployees.update'), false);
    check('the real parser error message is shown', alerts.some((a) => /must be a number/.test(a)), true);
  }

  // ---- Negative amount: blocked with the parser's own message ----
  {
    const els = baseEls();
    els['staff-salary-amount'] = { value: '-500' };
    els['staff-salary-period'] = { value: 'month' };
    const { sandbox, calls, alerts } = buildSaveSandbox({ els });
    await sandbox.saveStaffEmployee();
    check('a negative amount blocks the save', calls.some((c) => c[0] === 'PentaEmployees.update'), false);
    check('the real negative-amount message is shown', alerts.some((a) => /cannot be negative/.test(a)), true);
  }

  // ---- Both blank: explicitly allowed, save proceeds normally ----
  {
    const els = baseEls();
    els['staff-salary-amount'] = { value: '' };
    els['staff-salary-period'] = { value: '' };
    const { sandbox, calls } = buildSaveSandbox({ els });
    await sandbox.saveStaffEmployee();
    check('both blank does not block the save', calls.some((c) => c[0] === 'PentaEmployees.update'), true);
    const salCall = calls.find((c) => c[0] === '_staffSaveSalaryFields');
    check('the isolated salary write is still called, with null/null', salCall && [salCall[4], salCall[5]], [null, null]);
  }

  // ---- Valid amount + period: save proceeds, isolated write called with validated values ----
  {
    const els = baseEls();
    els['staff-salary-amount'] = { value: '$13,000.50' };
    els['staff-salary-period'] = { value: 'month' };
    const { sandbox, calls } = buildSaveSandbox({ els });
    await sandbox.saveStaffEmployee();
    check('the main dual-write still proceeds normally', calls.some((c) => c[0] === 'PentaEmployees.update'), true);
    const salCall = calls.find((c) => c[0] === '_staffSaveSalaryFields');
    check('the isolated salary write receives the parsed, rounded amount', salCall && salCall[4], 13000.5);
    check('the isolated salary write receives the chosen period', salCall && salCall[5], 'month');
    check('the isolated salary write is called with the right employee id', salCall && salCall[1], 'uuid-linda');
  }

  // ---- Pay Type = Hourly: salary fields never read, never validated, isolated write never called ----
  {
    const els = baseEls();
    els['staff-pay-type'] = { value: 'hourly' };
    els['staff-salary-amount'] = { value: 'this is garbage and would fail validation' };
    els['staff-salary-period'] = { value: '' };
    const { sandbox, calls, alerts } = buildSaveSandbox({ els });
    await sandbox.saveStaffEmployee();
    check('garbage left in a hidden salary field never blocks a Hourly save', calls.some((c) => c[0] === 'PentaEmployees.update'), true);
    check('no salary-validation alert fires when Pay Type is Hourly', alerts.length, 0);
    check('the isolated salary write is never called when Pay Type is Hourly (preserves whatever is already stored)', calls.some((c) => c[0] === '_staffSaveSalaryFields'), false);
  }
}

async function main() {
  await testSalaryWrite();
  await testSaveValidation();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
