// Server-side invites feature -- extracts and runs the ACTUAL
// sendBulkInvites()/_bulkInviteCapCheck() from index.html. Proves a
// single failure in the middle of a batch does NOT stop the rest, the
// final summary lists every outcome with its own reason, and the
// 10-per-click cap is enforced by unchecking (visibly), not silently.
//
// Run with: node tests/bulk-invite-continues-on-failure.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed: could not find start marker (' + label + '): ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed: could not find end marker after start (' + label + '): ' + endMarker);
  return src.slice(s, e);
}

const bulkSrc = extract(
  'var _bulkInviteSending = false;',
  '\n\nfunction matchClientByPhone(phone) {',
  'bulk invite functions'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const invokeCalls = [];
  const employees = opts.employees || [];
  const checkedIds = opts.checkedIds || [];
  const nodes = {};
  function el(id) { if (!nodes[id]) nodes[id] = { textContent: '', innerHTML: '', style: {}, disabled: false }; return nodes[id]; }
  const checkboxEls = checkedIds.map(function (id) { return { value: id, checked: true }; });

  const sandbox = {
    console,
    alert: function (msg) { sandbox._alerts.push(msg); },
    _alerts: [],
    _adminEsc: function (s) { return String(s); },
    document: {
      querySelectorAll: function (sel) { return sel === '.bulk-invite-check:checked' ? checkboxEls : []; },
      getElementById: function (id) { return el(id); },
    },
    window: {
      PentaEmployees: { listSync: function () { return employees; } },
      supabaseClient: {
        functions: {
          invoke: function (name, args) {
            invokeCalls.push(args.body.employee_id);
            return opts.invokeImpl(args.body.employee_id);
          },
        },
      },
    },
    // Real setTimeout, but 0ms -- keeps the test fast without changing
    // sendBulkInvites's own control flow (it really does await a delay
    // between sends).
    setTimeout: function (fn) { fn(); },
  };
  sandbox.renderStaffList = undefined; // absent on purpose -- the real code guards with typeof check
  vm.createContext(sandbox);
  vm.runInContext(bulkSrc, sandbox);
  return { sandbox: sandbox, invokeCalls: invokeCalls, nodes: nodes };
}

(async function () {
  console.log('Testing extracted sendBulkInvites() from index.html\n');

  const EMPLOYEES = [
    { id: 'emp-1', name: 'Ana' },
    { id: 'emp-2', name: 'Beto' },
    { id: 'emp-3', name: 'Caro' },
  ];

  // ---- One failure in the middle does not stop the batch. ----
  {
    const { sandbox, invokeCalls, nodes } = buildSandbox({
      employees: EMPLOYEES,
      checkedIds: ['emp-1', 'emp-2', 'emp-3'],
      invokeImpl: function (id) {
        if (id === 'emp-2') return Promise.resolve({ data: { success: false, error: 'No phone on file' }, error: null });
        return Promise.resolve({ data: { success: true }, error: null });
      },
    });
    await sandbox.sendBulkInvites();
    check('all 3 employees were attempted, not just the first 2', invokeCalls.length, 3);
    check('the batch reached emp-3 even though emp-2 failed in the middle', invokeCalls, ['emp-1', 'emp-2', 'emp-3']);
    const summaryHtml = nodes['bulk-invite-summary'].innerHTML;
    check('summary shows 2 sent, 1 failed', /2 sent, 1 failed/.test(summaryHtml), true);
    check('summary shows Ana succeeded', /Ana/.test(summaryHtml) && /color:var\(--green\)[^A]*Ana|Ana[\s\S]*?color:var\(--green\)/.test(summaryHtml) || /✓[\s\S]*Ana/.test(summaryHtml), true);
    check('summary shows Beto\'s specific failure reason, not a generic message', /Beto[\s\S]*No phone on file/.test(summaryHtml), true);
    check('summary shows Caro succeeded despite the earlier failure', /✓[\s\S]*Caro/.test(summaryHtml), true);
  }

  // ---- A thrown network error for one employee still lets the rest through. ----
  {
    const { sandbox, invokeCalls } = buildSandbox({
      employees: EMPLOYEES,
      checkedIds: ['emp-1', 'emp-2'],
      invokeImpl: function (id) {
        if (id === 'emp-1') return Promise.reject(new Error('network blip'));
        return Promise.resolve({ data: { success: true }, error: null });
      },
    });
    await sandbox.sendBulkInvites();
    check('a thrown error for the first employee does not stop the second', invokeCalls.length, 2);
  }

  // ---- Nothing selected shows a plain alert, never a silent no-op. ----
  {
    const { sandbox } = buildSandbox({ employees: EMPLOYEES, checkedIds: [], invokeImpl: function () { return Promise.resolve({ data: { success: true }, error: null }); } });
    await sandbox.sendBulkInvites();
    check('no selection shows a visible alert', sandbox._alerts.some(function (a) { return /Select at least one/.test(a); }), true);
  }

  console.log('\nTesting extracted _bulkInviteCapCheck()\n');

  // ---- The 10-per-click cap unchecks the 11th box with a visible message, never silently. ----
  {
    const progressNode = { style: {}, textContent: '' };
    const sandbox = {
      console,
      document: { getElementById: function (id) { return id === 'bulk-invite-progress' ? progressNode : null; }, querySelectorAll: function () { return new Array(11).fill(0); } },
    };
    vm.createContext(sandbox);
    vm.runInContext(bulkSrc, sandbox);
    const fakeCheckbox = { checked: true };
    sandbox._bulkInviteCapCheck(fakeCheckbox);
    check('the 11th checkbox gets unchecked', fakeCheckbox.checked, false);
    check('a visible message explains why', /Maximum 10 per click/.test(progressNode.textContent), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
