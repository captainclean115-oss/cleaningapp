// Admin/Office employee designation (migration 113) -- persistence
// through the REAL Staff-modal save path (saveStaffEmployee), not just
// _toRow/_fromRow in isolation.
//
// saveStaffEmployee builds its OWN hand-rolled Supabase `patch` object
// for its dual-write, separate from _toRow's mapping -- the exact gap
// that has already dropped a field from this dual-write FIVE times
// before (position in v9.5.1, is_team_leader/is_driver in v10.5.40,
// three more documented in this file's own history). This test proves
// work_type survives that specific path, confirms with the manager
// before an actual switch, calls switchEmployeeWorkType's side effects
// only after the write lands, and that declining the confirm writes
// nothing at all.
//
// Run with: node tests/admin-work-type-staff-modal-persistence.test.js

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

  // getStaffList() and the dual-write's own window.PentaEmployees.list()
  // read the SAME underlying facade cache in the real app -- one list,
  // not two. Rows need BOTH .id (the real Supabase uuid -- what emp.id
  // ends up as for an existing employee, and what .update()/
  // switchEmployeeWorkType must be called with) and .legacy_roster_id
  // (the human-readable roster key), matching PentaEmployees._fromRow's
  // actual shape.
  const staffList = opts.staffList || [];

  const sandbox = {
    console,
    alert: function (msg) { alerts.push(msg); },
    confirm: function (msg) { confirms.push(msg); return opts.confirmReturns !== undefined ? opts.confirmReturns : true; },
    document: { getElementById: getElementById },
    window: {
      supabaseClient: null,
      PentaAuth: null,
      PentaTeams: { getById: function () { return null; } },
      PentaEmployees: {
        list: function () { return Promise.resolve(staffList); },
        listSync: function () { return staffList; },
        insert: function (row) { calls.push(['PentaEmployees.insert', row]); return Promise.resolve(row); },
        update: function (id, patch) { calls.push(['PentaEmployees.update', id, patch]); return Promise.resolve({}); },
      },
    },
    getStaffList: function () { return staffList; },
    switchEmployeeWorkType: function (uuid, newWorkType) {
      calls.push(['switchEmployeeWorkType', uuid, newWorkType]);
      return Promise.resolve({ removedCount: 2 });
    },
    closeStaffModal: function () { calls.push(['closeStaffModal']); },
    renderStaffList: function () { calls.push(['renderStaffList']); },
  };

  vm.createContext(sandbox);
  vm.runInContext(saveSrc, sandbox);
  return { sandbox, calls, confirms, alerts, staffList };
}

async function main() {
  // ---- Switching an existing employee to Admin: confirms, writes
  // work_type through the real dual-write patch, and runs the switch
  // side effects only after the write lands ----
  {
    const existingEmp = { id: 'uuid-linda', legacy_roster_id: 'e1', business_id: 'biz-1', name: 'Linda Smith', work_type: 'field' };
    const { sandbox, calls, confirms } = buildSandbox({
      staffList: [existingEmp],
      els: {
        'staff-edit-idx': { value: '0' },
        'staff-first-name': { value: 'Linda' },
        'staff-last-name': { value: 'Smith' },
        'staff-work-type': { value: 'admin' },
        'staff-team': { value: '' },
      },
    });
    await sandbox.saveStaffEmployee();

    check('the manager is asked to confirm the switch', confirms.some(function (m) { return /Admin\/Office/.test(m) && /Linda Smith/.test(m); }), true);
    const updateCall = calls.find(function (c) { return c[0] === 'PentaEmployees.update'; });
    check('the real dual-write patch includes work_type=admin (the exact gap that bit this app 5 times before)', updateCall && updateCall[2].work_type, 'admin');
    check('team_id/team_text are forced null in the same write (no stale team survives the switch)', updateCall && updateCall[2].team_id, null);
    const switchCall = calls.find(function (c) { return c[0] === 'switchEmployeeWorkType'; });
    check('switchEmployeeWorkType side effects run, targeting the real Supabase uuid', switchCall && switchCall[1], 'uuid-linda');
    check('...with the new work type', switchCall && switchCall[2], 'admin');
    check('the side effects run AFTER the work_type write (update call comes before the switch call)',
      calls.indexOf(updateCall) < calls.indexOf(switchCall), true);
  }

  // ---- Declining the confirm writes nothing at all ----
  {
    const existingEmp = { id: 'uuid-linda', legacy_roster_id: 'e1', business_id: 'biz-1', name: 'Linda Smith', work_type: 'field' };
    const { sandbox, calls, confirms } = buildSandbox({
      confirmReturns: false,
      staffList: [existingEmp],
      els: {
        'staff-edit-idx': { value: '0' },
        'staff-first-name': { value: 'Linda' },
        'staff-last-name': { value: 'Smith' },
        'staff-work-type': { value: 'admin' },
        'staff-team': { value: '' },
      },
    });
    await sandbox.saveStaffEmployee();

    check('the manager was asked', confirms.length, 1);
    check('nothing at all was written once declined', calls.length, 0);
  }

  // ---- Switching back to field: no confirm consequence side effects, but still saved ----
  {
    const existingEmp = { id: 'uuid-pat', legacy_roster_id: 'e2', business_id: 'biz-1', name: 'Pat Jones', work_type: 'admin' };
    const { sandbox, calls, confirms } = buildSandbox({
      staffList: [existingEmp],
      els: {
        'staff-edit-idx': { value: '0' },
        'staff-first-name': { value: 'Pat' },
        'staff-last-name': { value: 'Jones' },
        'staff-work-type': { value: 'field' },
        'staff-team': { value: 'team-b1-id' },
      },
    });
    await sandbox.saveStaffEmployee();

    check('the manager is asked (switching back is also a real change)', confirms.some(function (m) { return /back to a Field team/.test(m); }), true);
    const updateCall = calls.find(function (c) { return c[0] === 'PentaEmployees.update'; });
    check('the patch carries work_type=field', updateCall && updateCall[2].work_type, 'field');
    const switchCall = calls.find(function (c) { return c[0] === 'switchEmployeeWorkType'; });
    check('switchEmployeeWorkType still runs (it decides internally there\'s nothing extra to do for field)', switchCall && switchCall[2], 'field');
  }

  // ---- No actual switch (unchanged Work Type): no confirm, no switchEmployeeWorkType call ----
  {
    const existingEmp = { id: 'uuid-alice', legacy_roster_id: 'e1', business_id: 'biz-1', name: 'Alice Jones', work_type: 'field' };
    const { sandbox, calls, confirms } = buildSandbox({
      staffList: [existingEmp],
      els: {
        'staff-edit-idx': { value: '0' },
        'staff-first-name': { value: 'Alice' },
        'staff-last-name': { value: 'Jones' },
        'staff-work-type': { value: 'field' }, // unchanged
        'staff-team': { value: 'team-b1-id' },
      },
    });
    await sandbox.saveStaffEmployee();

    check('no confirm is shown for an ordinary edit with no Work Type change', confirms.length, 0);
    check('switchEmployeeWorkType is never called when nothing actually switched', calls.some(function (c) { return c[0] === 'switchEmployeeWorkType'; }), false);
    const updateCall = calls.find(function (c) { return c[0] === 'PentaEmployees.update'; });
    check('the write still happens normally (work_type is still sent, just unchanged)', updateCall && updateCall[2].work_type, 'field');
  }

  // ---- A brand-new hire (idx === -1) never confirms a "switch" ----
  {
    const { sandbox, confirms } = buildSandbox({
      staffList: [],
      els: {
        'staff-edit-idx': { value: '-1' },
        'staff-first-name': { value: 'New' },
        'staff-last-name': { value: 'Hire' },
        'staff-work-type': { value: 'field' },
        'staff-team': { value: '' },
      },
    });
    await sandbox.saveStaffEmployee();
    check('inserting a brand-new hire never triggers the work-type-switch confirm', confirms.length, 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
