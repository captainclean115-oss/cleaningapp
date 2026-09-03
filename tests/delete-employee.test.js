// PR #155 -- "Delete Employee (permanent)" option under employee edit, for
// cleaning up test/junk employee records. Distinct from Terminate: this
// actually removes the row via a real DELETE (RLS policy employees_delete
// already exists for owner/admin/manager, confirmed live before building
// this). Most FK dependents (daily_assignments, time_entries,
// reward_ledger, forms, etc.) are ON DELETE CASCADE -- real history goes
// with it if any exists, so the confirm button stays disabled until real
// associated-data counts are checked and shown. job_applications.
// hired_employee_id is NOT cascading (NO ACTION) -- confirmDeleteEmployee
// nulls that link first (keeping the application record itself, same
// pattern as the Melissa reward_submissions cleanup earlier this project)
// so a delete doesn't fail outright or silently take the application too.
//
// Run with: node tests/delete-employee.test.js

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

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// --- Structural: both buttons wired, both hidden by default, both revealed on edit ---
check('main-emp Delete button exists, hidden by default', /id="main-emp-hard-delete" style="display:none/.test(src), true);
check('staff Delete button exists, hidden by default', /id="staff-hard-delete-btn" style="display:none/.test(src), true);
const openMainEmpModalFn = extract('function openMainEmpModal() {', "\nfunction openMainEmpEdit(idx) {", 'openMainEmpModal');
const openMainEmpEditFn = extract('function openMainEmpEdit(idx) {', "\nfunction ", 'openMainEmpEdit');
check("opening a NEW main employee (openMainEmpModal) hides the Delete button", openMainEmpModalFn.indexOf("main-emp-hard-delete').style.display = 'none'") !== -1, true);
check("editing an existing main employee (openMainEmpEdit) reveals the Delete button", openMainEmpEditFn.indexOf("main-emp-hard-delete').style.display = 'block'") !== -1, true);

// --- Behavioral: openDeleteEmployeeModal's UUID guard (same pattern as Terminate) ---
const openFnSource = extract('function openDeleteEmployeeModal(idx, source) {', '\n\nfunction closeDeleteEmployeeModal', 'openDeleteEmployeeModal');
{
  const alerts = [];
  const countsCalls = [];
  const sandbox = {
    console,
    UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    getStaffList: () => [{ id: 'not-a-uuid', name: 'Legacy Row' }],
    getMainEmpList: () => [{ id: '11111111-1111-1111-1111-111111111111', name: 'Real Employee', auth_user_id: 'auth-uuid-1' }],
    alert: (m) => alerts.push(m),
    document: { getElementById: () => ({ style: {}, textContent: '' }) },
    _renderDeleteEmployeeCounts: (uuid, hasAuthAccount) => countsCalls.push([uuid, hasAuthAccount]),
  };
  vm.createContext(sandbox);
  vm.runInContext('var _deleteEmployeeCtx = null;\n' + openFnSource, sandbox);

  sandbox.openDeleteEmployeeModal('0', 'staff');
  check('a non-UUID (legacy, no linked account) employee is rejected with a clear alert, not opened', alerts.length, 1);

  sandbox.openDeleteEmployeeModal('0', 'main');
  check('a real UUID employee is accepted (no rejection alert)', alerts.length, 1);
  check('_deleteEmployeeCtx is set with the right uuid/name/source', sandbox._deleteEmployeeCtx, { uuid: '11111111-1111-1111-1111-111111111111', name: 'Real Employee', source: 'main' });
  check('_renderDeleteEmployeeCounts is told whether the employee has a login account, so the modal can disclose it will also be deleted', countsCalls[countsCalls.length - 1], ['11111111-1111-1111-1111-111111111111', true]);
}

// --- Behavioral: PentaEmployees.hardDelete ---
const hardDeleteFn = extract('async function hardDelete(id) {', '\n  }\n', 'hardDelete') + '\n  }\n';

// --- Behavioral: confirmDeleteEmployee ---
const confirmFnSource = extract('async function confirmDeleteEmployee() {', '\n\n// PR #149 — Rehire', 'confirmDeleteEmployee');

// --- Behavioral: _renderDeleteEmployeeCounts discloses the linked login account ---
const countsFnSource = extract('async function _renderDeleteEmployeeCounts(uuid, hasAuthAccount) {', '\n\nasync function confirmDeleteEmployee', '_renderDeleteEmployeeCounts');

function buildCountsSandbox() {
  const els = { 'del-emp-counts': { innerHTML: '', textContent: '' }, 'del-emp-confirm-btn': { disabled: true, textContent: '', style: {} } };
  const sandbox = {
    console,
    document: { getElementById: (id) => els[id] || null },
    window: {
      supabaseClient: {
        from: () => ({ select: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(countsFnSource, sandbox);
  return { sandbox, els };
}

(async () => {
  // hardDelete: routes through the delete_employee_with_auth RPC (PR #157
  // -- a plain `DELETE FROM employees` left orphaned auth.users rows,
  // confirmed live to block re-inviting the same email later), updates
  // the local cache, notifies.
  {
    let rpcCall = null, notified = false;
    const cache = [{ id: 'emp-1', name: 'Test Emp' }, { id: 'emp-2', name: 'Keep Me' }];
    const sandbox = {
      console,
      _cacheReady: true,
      _cache: cache,
      _hydrate: () => Promise.resolve(),
      _notify: () => { notified = true; },
      SB: () => ({
        rpc: (fn, args) => { rpcCall = [fn, args]; return Promise.resolve({ error: null }); },
      }),
    };
    vm.createContext(sandbox);
    vm.runInContext(hardDeleteFn, sandbox);
    await sandbox.hardDelete('emp-1');
    check('hardDelete calls the delete_employee_with_auth RPC with the target id (not a plain employees delete)', rpcCall, ['delete_employee_with_auth', { p_employee_id: 'emp-1' }]);
    check('hardDelete removes the row from the local cache', cache.map(e => e.id), ['emp-2']);
    check('hardDelete notifies listeners so the UI re-renders', notified, true);
  }

  // hardDelete: DB/RPC error (e.g. the job_applications NO ACTION block, or
  // the RPC's own authorization check) throws, not swallowed.
  {
    const sandbox = {
      console, _cacheReady: true, _cache: [],
      _hydrate: () => Promise.resolve(), _notify: () => {},
      SB: () => ({ rpc: () => Promise.resolve({ error: new Error('foreign key violation') }) }),
    };
    vm.createContext(sandbox);
    vm.runInContext(hardDeleteFn, sandbox);
    let threw = null;
    try { await sandbox.hardDelete('emp-1'); } catch (e) { threw = e.message; }
    check('hardDelete throws (not silently swallows) on a DB-level error', threw, 'foreign key violation');
  }

  // confirmDeleteEmployee: nulls job_applications.hired_employee_id BEFORE deleting.
  {
    const calls = [];
    const elements = {
      'del-emp-error': { style: {}, textContent: '' },
      'del-emp-confirm-btn': { disabled: false, textContent: '' },
    };
    const sandbox = {
      console,
      _deleteEmployeeCtx: { uuid: 'emp-1', name: 'Test Emp', source: 'staff' },
      document: { getElementById: (id) => elements[id] || null },
      window: {
        supabaseClient: {
          from: (table) => ({
            update: (patch) => ({ eq: (col, val) => { calls.push(['update', table, patch, col, val]); return Promise.resolve({ error: null }); } }),
          }),
        },
        PentaEmployees: {
          hardDelete: (id) => { calls.push(['hardDelete', id]); return Promise.resolve(); },
        },
      },
      closeDeleteEmployeeModal: () => calls.push(['closeDeleteEmployeeModal']),
      renderStaffList: () => calls.push(['renderStaffList']),
      renderStaffSubview: () => calls.push(['renderStaffSubview']),
      showToast: () => calls.push(['toast']),
    };
    vm.createContext(sandbox);
    vm.runInContext(confirmFnSource, sandbox);
    await sandbox.confirmDeleteEmployee();

    const updateCallIdx = calls.findIndex(c => c[0] === 'update');
    const hardDeleteCallIdx = calls.findIndex(c => c[0] === 'hardDelete');
    check('job_applications.hired_employee_id is nulled for this employee', calls[updateCallIdx].slice(1), ['job_applications', { hired_employee_id: null }, 'hired_employee_id', 'emp-1']);
    check('the application link is cleared BEFORE the employee row is deleted (order matters for the NO ACTION FK)', updateCallIdx < hardDeleteCallIdx, true);
    check('hardDelete is called with the correct employee uuid', calls[hardDeleteCallIdx][1], 'emp-1');
    check('the staff list re-renders after a successful delete', calls.some(c => c[0] === 'renderStaffList'), true);
  }

  // confirmDeleteEmployee: a thrown error is surfaced, not swallowed, and re-enables the button.
  {
    const elements = {
      'del-emp-error': { style: {}, textContent: '' },
      'del-emp-confirm-btn': { disabled: false, textContent: '' },
    };
    const sandbox = {
      console,
      _deleteEmployeeCtx: { uuid: 'emp-1', name: 'Test Emp', source: 'main' },
      document: { getElementById: (id) => elements[id] || null },
      window: {
        supabaseClient: {
          from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
        },
        PentaEmployees: { hardDelete: () => Promise.reject(new Error('permission denied')) },
      },
      renderMainEmployees: () => {},
      showToast: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(confirmFnSource, sandbox);
    await sandbox.confirmDeleteEmployee();
    check('a hardDelete failure surfaces its real error message', elements['del-emp-error'].textContent, 'permission denied');
    check('the confirm button is re-enabled after a failure (not stuck disabled)', elements['del-emp-confirm-btn'].disabled, false);
  }

  // _renderDeleteEmployeeCounts: discloses the linked login account will also be deleted.
  {
    const { sandbox, els } = buildCountsSandbox();
    await sandbox._renderDeleteEmployeeCounts('emp-1', true);
    check('an employee WITH a login account gets an explicit note that it will be deleted too', els['del-emp-counts'].innerHTML.indexOf('Has a login account') !== -1, true);
  }
  {
    const { sandbox, els } = buildCountsSandbox();
    await sandbox._renderDeleteEmployeeCounts('emp-1', false);
    check('an employee with NO login account gets no auth-account note (nothing to disclose)', els['del-emp-counts'].innerHTML.indexOf('Has a login account') !== -1, false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
