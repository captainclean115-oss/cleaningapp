// Stage 1 of 3: "make manager from the employee profile."
//
// Grants/revokes manager-tier access (users.role) from a new "Manager
// Access" section on the Staff View/Edit tabs, reusing the employee's
// existing record instead of the old Teams > Invite Manager popup
// questionnaire. This file drives the REAL _pentaSetManagerAccess /
// _renderManagerAccessSection (extracted from index.html, run in a vm
// sandbox against a fake Supabase `users` table) with FAKE people only.
//
// Run with: node tests/stage1-manager-promotion.test.js

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

function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker after ' + startMarker); process.exit(1); }
  return src.slice(s, e);
}

const helperSrc = extract('function _pentaIsOwnerOrAdmin() {', '\nfunction renderStaffView() {');

function buildSandbox(opts) {
  opts = opts || {};
  const state = {
    usersTable: opts.usersTable || [], // [{id, auth_user_id, business_id, email, role, manager_permissions}]
    inviteCalls: [],
    alerts: [],
    prompts: opts.prompts || [],
    employeeUpdates: []
  };
  const sb = {
    from: function (table) {
      if (table !== 'users') throw new Error('unexpected table: ' + table);
      return {
        select: function () {
          var filters = {};
          var chain = {
            eq: function (col, val) { filters[col] = val; return chain; },
            maybeSingle: function () {
              var row = state.usersTable.find(function (r) {
                return Object.keys(filters).every(function (k) { return r[k] === filters[k]; });
              });
              return Promise.resolve({ data: row || null, error: null });
            }
          };
          return chain;
        },
        update: function (patch) {
          return {
            eq: function (col, val) {
              var row = state.usersTable.find(function (r) { return r[col] === val; });
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: row ? null : { message: 'no matching row' } });
            }
          };
        },
        insert: function (row) {
          var saved = Object.assign({ id: 'new-user-' + (state.usersTable.length + 1) }, row);
          state.usersTable.push(saved);
          return {
            select: function () {
              return { maybeSingle: function () { return Promise.resolve({ data: saved, error: null }); } };
            }
          };
        }
      };
    }
  };
  const sandbox = {
    console,
    window: {
      supabaseClient: sb,
      PentaTenant: { current: function () { return 'biz-fake-1'; } },
      PentaEmployees: { update: function (id, patch) { state.employeeUpdates.push([id, patch]); return Promise.resolve(); } }
    },
    getCurrentAppRole: function () { return opts.viewerRole || null; },
    _pentaParseAuthToken: function () { return { user: { id: opts.viewerAuthId || 'viewer-auth-id' } }; },
    alert: function (msg) { state.alerts.push(msg); },
    prompt: function () { return state.prompts.length ? state.prompts.shift() : null; },
    pentaSendInvite: function (rid) { state.inviteCalls.push(rid); return Promise.resolve(); }
  };
  vm.createContext(sandbox);
  vm.runInContext(helperSrc, sandbox);
  return { sandbox: sandbox, state: state };
}

function fakeEmployee(overrides) {
  return Object.assign({
    id: 'emp-fake-1',
    legacy_roster_id: 'e_fake_1',
    name: 'Testy McTestface',
    first_name: 'Testy',
    last_name: 'McTestface',
    business_id: 'biz-fake-1',
    phone: null,
    email: null,
    auth_user_id: null
  }, overrides || {});
}

async function main() {
  // ---- Only owner/admin may grant manager access. ----
  {
    const { sandbox, state } = buildSandbox({ viewerRole: 'manager' });
    const emp = fakeEmployee();
    const ok = await sandbox._pentaSetManagerAccess(emp, true);
    check('a plain manager cannot grant manager access', ok, false);
    check('no users row was created', state.usersTable.length, 0);
    check('an alert explains why', state.alerts.some(function (m) { return /owner or admin/i.test(m); }), true);
  }

  // ---- Owner promotes someone who already has a login: immediate,
  // no invite needed. ----
  {
    const { sandbox, state } = buildSandbox({ viewerRole: 'owner', viewerAuthId: 'owner-auth-1' });
    const emp = fakeEmployee({ auth_user_id: 'employee-auth-2', email: 'already.loggedin@example.invalid' });
    const ok = await sandbox._pentaSetManagerAccess(emp, true);
    check('promotion succeeds for someone who already has a login', ok, true);
    check('a users row now exists with role=manager', state.usersTable.some(function (r) { return r.auth_user_id === 'employee-auth-2' && r.role === 'manager'; }), true);
    check('no invite is sent -- she can already sign in', state.inviteCalls.length, 0);
  }

  // ---- Owner promotes someone with no login yet, but with a phone on
  // file already: no prompt, invite goes out. ----
  {
    const { sandbox, state } = buildSandbox({ viewerRole: 'owner', viewerAuthId: 'owner-auth-1' });
    const emp = fakeEmployee({ phone: '5551234567' });
    const ok = await sandbox._pentaSetManagerAccess(emp, true);
    check('promotion succeeds for someone with no login but a phone on file', ok, true);
    check('no prompt was shown -- nothing was missing', state.alerts.some(function (m) { return /phone number/i.test(m); }), false);
    check('an invite was sent', state.inviteCalls.length, 1);
    check('the invite targets the right roster id', state.inviteCalls[0], 'e_fake_1');
  }

  // ---- Owner promotes someone with no login and no phone: asks for
  // ONLY the phone (no long questionnaire), then invites. ----
  {
    const { sandbox, state } = buildSandbox({ viewerRole: 'owner', viewerAuthId: 'owner-auth-1', prompts: ['5559876543'] });
    const emp = fakeEmployee();
    const ok = await sandbox._pentaSetManagerAccess(emp, true);
    check('promotion succeeds after supplying the missing phone', ok, true);
    check('the phone gets saved onto the employee record', state.employeeUpdates.some(function (u) { return u[0] === emp.id && u[1].phone === '5559876543'; }), true);
    check('an invite was sent once the phone was supplied', state.inviteCalls.length, 1);
  }

  // ---- Nobody can change their own access -- not even the owner. ----
  {
    const { sandbox, state } = buildSandbox({ viewerRole: 'owner', viewerAuthId: 'owner-auth-1' });
    const emp = fakeEmployee({ auth_user_id: 'owner-auth-1' }); // same id as the viewer
    const ok = await sandbox._pentaSetManagerAccess(emp, true);
    check('an owner cannot grant/revoke their own access', ok, false);
    check('an alert explains why', state.alerts.some(function (m) { return /own access/i.test(m); }), true);
  }

  // ---- This control can never touch an owner's or admin's role --
  // satisfies "nobody can remove the last owner" and "cannot promote
  // to owner" by construction (no code path here sets/clears 'owner'). ----
  {
    const { sandbox, state } = buildSandbox({
      viewerRole: 'owner', viewerAuthId: 'owner-auth-1',
      usersTable: [{ id: 'u1', auth_user_id: 'other-owner-auth', business_id: 'biz-fake-1', role: 'owner', manager_permissions: {} }]
    });
    const emp = fakeEmployee({ auth_user_id: 'other-owner-auth' });
    const ok = await sandbox._pentaSetManagerAccess(emp, false);
    check('turning the toggle off for an owner is refused, not silently demoting them', ok, false);
    check('the owner row is untouched', state.usersTable[0].role, 'owner');
  }

  // ---- Revoking an existing manager returns them to employee-only
  // (role flips, row is kept rather than deleted). ----
  {
    const { sandbox, state } = buildSandbox({
      viewerRole: 'admin', viewerAuthId: 'admin-auth-1',
      usersTable: [{ id: 'u2', auth_user_id: 'mgr-auth-1', business_id: 'biz-fake-1', role: 'manager', manager_permissions: { some_key: false } }]
    });
    const emp = fakeEmployee({ auth_user_id: 'mgr-auth-1' });
    const ok = await sandbox._pentaSetManagerAccess(emp, false);
    check('revoking succeeds', ok, true);
    check('role flips to employee', state.usersTable[0].role, 'employee');
    check('the row is kept (not deleted) so her prior permission choices survive', state.usersTable.length, 1);
  }

  // ---- Re-promoting someone who was previously demoted restores their
  // old manager_permissions instead of resetting them. ----
  {
    const { sandbox, state } = buildSandbox({
      viewerRole: 'owner', viewerAuthId: 'owner-auth-1',
      usersTable: [{ id: 'u3', auth_user_id: 'mgr-auth-2', business_id: 'biz-fake-1', role: 'employee', manager_permissions: { kept_key: false } }]
    });
    const emp = fakeEmployee({ auth_user_id: 'mgr-auth-2' });
    const ok = await sandbox._pentaSetManagerAccess(emp, true);
    check('re-promotion succeeds', ok, true);
    check('role flips back to manager', state.usersTable[0].role, 'manager');
    check('her prior manager_permissions survive the round trip', state.usersTable[0].manager_permissions, { kept_key: false });
  }

  // ---- _renderManagerAccessSection: a non-owner/admin viewer sees
  // status only, never the toggle. ----
  {
    const { sandbox } = buildSandbox({ viewerRole: 'manager' });
    const emp = fakeEmployee({ auth_user_id: 'mgr-auth-3' });
    const statusEl = { textContent: '' };
    const toggleWrap = { style: { display: 'none' } };
    const toggleEl = { checked: false, onchange: null };
    const permLinkEl = { style: { display: 'none' } };
    await sandbox._renderManagerAccessSection(emp, { statusEl: statusEl, toggleWrap: toggleWrap, toggleEl: toggleEl, permLinkEl: permLinkEl });
    check('the toggle stays hidden for a non-owner/admin viewer', toggleWrap.style.display, 'none');
  }

  // ---- _renderManagerAccessSection: an owner/admin target shows
  // read-only status with no toggle, even to an owner viewer. ----
  {
    const { sandbox } = buildSandbox({
      viewerRole: 'owner', viewerAuthId: 'owner-auth-1',
      usersTable: [{ id: 'u4', auth_user_id: 'other-admin-auth', business_id: 'biz-fake-1', role: 'admin', manager_permissions: {} }]
    });
    const emp = fakeEmployee({ auth_user_id: 'other-admin-auth' });
    const statusEl = { textContent: '' };
    const toggleWrap = { style: { display: 'none' } };
    const toggleEl = { checked: false, onchange: null };
    const permLinkEl = { style: { display: 'none' } };
    await sandbox._renderManagerAccessSection(emp, { statusEl: statusEl, toggleWrap: toggleWrap, toggleEl: toggleEl, permLinkEl: permLinkEl });
    check('an admin target shows read-only status', /Admin.*full access/i.test(statusEl.textContent), true);
    check('no toggle is offered for an admin target', toggleWrap.style.display, 'none');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
