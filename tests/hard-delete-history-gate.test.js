// Hard Delete fix (D) -- the pre-delete history gate, against the REAL
// extracted _deleteEmployeeHistoryCounts/_renderDeleteEmployeeCounts/
// confirmDeleteEmployee. Covers exactly the two cases the spec asked
// for: an employee with ONLY manual_hour_overrides rows (nothing in
// the four originally-checked tables) is blocked, and an employee with
// genuinely zero history anywhere is allowed through.
//
// Run with: node tests/hard-delete-history-gate.test.js

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

const historyCountsSrc = extract(
  'var _DELETE_EMPLOYEE_HISTORY_CHECKS = [',
  '\n\nasync function _renderDeleteEmployeeCounts',
  '_deleteEmployeeHistoryCounts'
);
const countsFnSrc = extract(
  'async function _renderDeleteEmployeeCounts(uuid, hasAuthAccount) {',
  '\n\nasync function confirmDeleteEmployee',
  '_renderDeleteEmployeeCounts'
);
const confirmFnSrc = extract(
  'async function confirmDeleteEmployee() {',
  '\n\n// PR #149 — Rehire',
  'confirmDeleteEmployee'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// counts: { table_name: count } -- any table not listed defaults to 0.
function buildSupabaseMock(counts) {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => Promise.resolve({ count: (counts && counts[table]) || 0, error: null }),
      }),
      update: (patch) => ({ eq: (col, val) => Promise.resolve({ error: null }) }),
    }),
  };
}

function buildCountsSandbox(counts) {
  const els = { 'del-emp-counts': { innerHTML: '', textContent: '' }, 'del-emp-confirm-btn': { disabled: false, textContent: '', style: {} } };
  const sandbox = {
    console,
    document: { getElementById: (id) => els[id] || null },
    window: { supabaseClient: buildSupabaseMock(counts) },
  };
  vm.createContext(sandbox);
  vm.runInContext(historyCountsSrc, sandbox);
  vm.runInContext(countsFnSrc, sandbox);
  return { sandbox, els };
}

function buildConfirmSandbox(counts, opts) {
  opts = opts || {};
  const calls = [];
  const elements = {
    'del-emp-error': { style: {}, textContent: '' },
    'del-emp-confirm-btn': { disabled: false, textContent: '' },
  };
  const sandbox = {
    console,
    _deleteEmployeeCtx: { uuid: 'emp-1', name: 'Test Emp', source: 'staff' },
    document: { getElementById: (id) => elements[id] || null },
    _auditSupplement: (action_type, entity_type, entity_id, new_values) => {
      calls.push(['_auditSupplement', action_type, entity_type, entity_id, new_values]);
      return Promise.resolve();
    },
    window: {
      supabaseClient: buildSupabaseMock(counts),
      PentaEmployees: { hardDelete: (id) => { calls.push(['hardDelete', id]); return Promise.resolve(); } },
    },
    closeDeleteEmployeeModal: () => calls.push(['closeDeleteEmployeeModal']),
    renderStaffList: () => calls.push(['renderStaffList']),
    renderStaffSubview: () => calls.push(['renderStaffSubview']),
    showToast: (msg, kind) => calls.push(['toast', msg, kind]),
  };
  vm.createContext(sandbox);
  vm.runInContext(historyCountsSrc, sandbox);
  vm.runInContext(confirmFnSrc, sandbox);
  return { sandbox, elements, calls };
}

async function main() {
  // ---- UI: an employee with ONLY manual_hour_overrides rows (0 in every other table) is flagged ----
  {
    const { sandbox, els } = buildCountsSandbox({ manual_hour_overrides: 12 });
    await sandbox._renderDeleteEmployeeCounts('emp-1', false);
    check('the Delete button is disabled (manual_hour_overrides-only history)', els['del-emp-confirm-btn'].disabled, true);
    check('the button label steers to Terminate', els['del-emp-confirm-btn'].textContent, 'Use Terminate Instead');
    check('the warning message says plainly to use Terminate instead', els['del-emp-counts'].innerHTML.indexOf('This employee has history. Use Terminate instead.') !== -1, true);
    check('the manual_hour_overrides count itself is shown', els['del-emp-counts'].innerHTML.indexOf('Manual hour overrides') !== -1, true);
  }

  // ---- UI: genuinely zero history anywhere -- button enabled, safe-to-delete message ----
  {
    const { sandbox, els } = buildCountsSandbox({});
    await sandbox._renderDeleteEmployeeCounts('emp-2', false);
    check('the Delete button is enabled (zero history anywhere)', els['del-emp-confirm-btn'].disabled, false);
    check('the button label is the normal delete action', els['del-emp-confirm-btn'].textContent, 'Delete Permanently');
    check('the message says it looks safe to delete', els['del-emp-counts'].innerHTML.indexOf('looks safe to delete') !== -1, true);
  }

  // ---- Write-path gate: confirmDeleteEmployee REFUSES even if somehow called with manual_hour_overrides-only history ----
  {
    const { sandbox, elements, calls } = buildConfirmSandbox({ manual_hour_overrides: 3 });
    await sandbox.confirmDeleteEmployee();
    check('hardDelete is NEVER called when manual_hour_overrides has rows, even bypassing the UI', calls.some((c) => c[0] === 'hardDelete'), false);
    check('a clear error is shown naming the reason', elements['del-emp-error'].textContent, 'This employee has history. Use Terminate instead.');
    check('the confirm button is re-enabled after the refusal (not stuck disabled)', elements['del-emp-confirm-btn'].disabled, false);
  }

  // ---- Write-path gate: zero history anywhere -- delete proceeds, audit written first ----
  {
    const { sandbox, calls } = buildConfirmSandbox({});
    await sandbox.confirmDeleteEmployee();
    check('hardDelete IS called when there is genuinely zero history', calls.some((c) => c[0] === 'hardDelete' && c[1] === 'emp-1'), true);
    const auditCall = calls.find((c) => c[0] === '_auditSupplement');
    check('a best-effort audit_log write happens BEFORE the hardDelete call', calls.indexOf(auditCall) < calls.findIndex((c) => c[0] === 'hardDelete'), true);
    check('the audit entry carries the employee name', auditCall[4].employee_name, 'Test Emp');
    check('the audit entry carries the zero counts just confirmed', auditCall[4].counts.every((r) => r.count === 0), true);
    check('the delete completes and closes the modal', calls.some((c) => c[0] === 'closeDeleteEmployeeModal'), true);
  }

  // ---- Write-path gate: a failed audit write shows a VISIBLE warning, but does not block the delete ----
  {
    const { sandbox, calls } = buildConfirmSandbox({});
    sandbox._auditSupplement = () => Promise.reject(new Error('audit insert failed'));
    await sandbox.confirmDeleteEmployee();
    check('hardDelete still proceeds even though the audit write failed', calls.some((c) => c[0] === 'hardDelete'), true);
    check('a visible toast warning is shown for the audit failure, not just a console line', calls.some((c) => c[0] === 'toast' && /audit log entry could not be saved/.test(c[1])), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
