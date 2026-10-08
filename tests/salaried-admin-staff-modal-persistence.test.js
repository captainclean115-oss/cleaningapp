// Salaried Admin/Office (follow-up to migration 113) -- pay_type
// persistence through the REAL saveStaffEmployee save path, not just
// a hypothetical mapping. Reuses the existing employees.pay_type
// column (employee_pay_type enum: 'hourly' | 'salary' -- confirmed
// live via information_schema). This is the SAME dual-write gap
// work_type was added to in the parent PR -- proving it here the same
// way, against the real extracted function.
//
// Run with: node tests/salaried-admin-staff-modal-persistence.test.js

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

function defaultEl() { return { value: '', checked: false, files: [], textContent: '' }; }

function buildSandbox(opts) {
  opts = opts || {};
  const calls = [];
  const confirms = [];
  const alerts = [];
  const elCache = {};
  const overrides = opts.els || {};

  function getElementById(id) {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
    if (!elCache[id]) elCache[id] = defaultEl();
    return elCache[id];
  }

  const staffList = opts.staffList || [];

  const sandbox = {
    console,
    alert: (msg) => alerts.push(msg),
    confirm: (msg) => { confirms.push(msg); return opts.confirmReturns !== undefined ? opts.confirmReturns : true; },
    document: { getElementById },
    window: {
      supabaseClient: null,
      PentaAuth: null,
      PentaTeams: { getById: () => null },
      PentaEmployees: {
        list: () => Promise.resolve(staffList),
        listSync: () => staffList,
        insert: (row) => { calls.push(['PentaEmployees.insert', row]); return Promise.resolve(row); },
        update: (id, patch) => { calls.push(['PentaEmployees.update', id, patch]); return Promise.resolve({}); },
      },
    },
    getStaffList: () => staffList,
    switchEmployeeWorkType: (uuid, newWorkType) => { calls.push(['switchEmployeeWorkType', uuid, newWorkType]); return Promise.resolve({ removedCount: 0 }); },
    closeStaffModal: () => calls.push(['closeStaffModal']),
    renderStaffList: () => calls.push(['renderStaffList']),
    // Salary amount/period (migration 114 follow-up) -- real bare-global
    // helpers saveStaffEmployee's body now calls. None of this file's 4
    // cases populate a salary amount/period input, so the real parser's
    // "blank is valid" behavior is all that's needed here; the isolated
    // write itself is covered by its own dedicated test file.
    _parseSalaryAmountInput: (raw) => {
      var s = String(raw == null ? '' : raw).trim();
      if (s === '') return { ok: true, value: null };
      var cleaned = s.replace(/^\$/, '').replace(/,/g, '').trim();
      if (!/^\d+(\.\d+)?$/.test(cleaned)) return { ok: false, error: 'Salary amount must be a number.' };
      return { ok: true, value: Math.round(parseFloat(cleaned) * 100) / 100 };
    },
    _staffSaveSalaryFields: (id, empName, oldAmt, oldPer, newAmt, newPer) => {
      calls.push(['_staffSaveSalaryFields', id, oldAmt, oldPer, newAmt, newPer]);
      return Promise.resolve();
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(saveSrc, sandbox);
  return { sandbox, calls, confirms, alerts, staffList };
}

async function main() {
  // ---- Switching an existing Admin/Office employee to Salaried persists through the real dual-write patch ----
  {
    const existingEmp = { id: 'uuid-linda', legacy_roster_id: 'e1', business_id: 'biz-1', name: 'Linda Smith', work_type: 'admin', pay_type: 'hourly' };
    const { sandbox, calls } = buildSandbox({
      staffList: [existingEmp],
      els: {
        'staff-edit-idx': { value: '0' },
        'staff-first-name': { value: 'Linda' },
        'staff-last-name': { value: 'Smith' },
        'staff-work-type': { value: 'admin' }, // unchanged -- isolates the pay_type-only switch
        'staff-pay-type': { value: 'salary' },
        'staff-team': { value: '' },
      },
    });
    await sandbox.saveStaffEmployee();

    const updateCall = calls.find((c) => c[0] === 'PentaEmployees.update');
    check('the real dual-write patch includes pay_type=salary (same gap class work_type was added to)', updateCall && updateCall[2].pay_type, 'salary');
    check('switchEmployeeWorkType is NOT triggered by a pay_type-only change (work_type did not switch)', calls.some((c) => c[0] === 'switchEmployeeWorkType'), false);
  }

  // ---- No confirm dialog for a Pay Type change alone (only Work Type has manager-visible consequences) ----
  {
    const existingEmp = { id: 'uuid-linda', legacy_roster_id: 'e1', business_id: 'biz-1', name: 'Linda Smith', work_type: 'admin', pay_type: 'hourly' };
    const { sandbox, confirms } = buildSandbox({
      staffList: [existingEmp],
      els: {
        'staff-edit-idx': { value: '0' },
        'staff-first-name': { value: 'Linda' },
        'staff-last-name': { value: 'Smith' },
        'staff-work-type': { value: 'admin' },
        'staff-pay-type': { value: 'salary' },
        'staff-team': { value: '' },
      },
    });
    await sandbox.saveStaffEmployee();
    check('switching Pay Type alone does not trigger the Work Type confirm dialog', confirms.length, 0);
  }

  // ---- Unchanged Pay Type still round-trips correctly (no accidental reset to hourly) ----
  {
    const existingEmp = { id: 'uuid-linda', legacy_roster_id: 'e1', business_id: 'biz-1', name: 'Linda Smith', work_type: 'admin', pay_type: 'salary' };
    const { sandbox, calls } = buildSandbox({
      staffList: [existingEmp],
      els: {
        'staff-edit-idx': { value: '0' },
        'staff-first-name': { value: 'Linda' },
        'staff-last-name': { value: 'Smith' },
        'staff-work-type': { value: 'admin' },
        'staff-pay-type': { value: 'salary' },
        'staff-team': { value: '' },
      },
    });
    await sandbox.saveStaffEmployee();
    const updateCall = calls.find((c) => c[0] === 'PentaEmployees.update');
    check('an already-salaried employee stays salary on an unrelated re-save', updateCall && updateCall[2].pay_type, 'salary');
  }

  // ---- A new hire defaults to hourly ----
  {
    const { sandbox, calls } = buildSandbox({
      staffList: [],
      els: {
        'staff-edit-idx': { value: '-1' },
        'staff-first-name': { value: 'New' },
        'staff-last-name': { value: 'Hire' },
        'staff-work-type': { value: 'field' },
        'staff-pay-type': { value: 'hourly' },
        'staff-team': { value: '' },
      },
    });
    await sandbox.saveStaffEmployee();
    const insertCall = calls.find((c) => c[0] === 'PentaEmployees.insert');
    check('a brand-new hire inserts with pay_type=hourly', insertCall && insertCall[1].pay_type, 'hourly');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
