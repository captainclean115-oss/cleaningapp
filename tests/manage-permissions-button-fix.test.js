// Tom tapped "Manage permissions" on Nadia's profile after promoting
// her (Stage 1's "Give manager access" switch) and nothing happened --
// no panel, no error.
//
// TWO real bugs, confirmed live against Supabase (no personal values
// printed here, fake data only in this file):
//
// 1. openManagerPermissionsModal awaited a Supabase call with no
//    timeout and its own onclick call site never caught a rejection
//    either -- a stalled network call left the tap doing literally
//    nothing. Reproduced in a sandbox: feeding it a call that never
//    resolves hangs the promise forever with zero visible feedback.
//
// 2. _pentaSetManagerAccess's "existing users row" branch only ever
//    updated role, never manager_permissions -- so promoting someone
//    who already had a `users` row (role='employee', e.g. Nadia, an
//    existing field employee) never got the Limited manager preset,
//    even though a brand-new row did. Confirmed live: Nadia's row was
//    role='manager', manager_permissions={} -- full, unrestricted
//    access, not Limited.
//
// This file drives the REAL _pentaSetManagerAccess / openManagerPermissionsModal
// / _renderManagerAccessSection / _pentaDescribePreset (extracted from
// index.html, run in a vm sandbox) with FAKE people only.
//
// Run with: node tests/manage-permissions-button-fix.test.js

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

const timeoutSrc = extract('function _pentaWithTimeout(promise, ms) {', '\nfunction _pentaClearStaleSession() {');
// Covers _pentaDescribePreset, _pentaPermsObjectsMatch, _pentaIsOwnerOrAdmin,
// _pentaFetchUserRoleRow, _pentaSetManagerAccess, _renderManagerAccessSection,
// _openManagerPermissionsModalInner, openManagerPermissionsModal -- all
// declared back-to-back in this order.
const blockSrc = extract('// manage-permissions-button-fix: classifies', '\nfunction renderStaffView() {');
const presetSrc = extract('var SCHEDULE_PERMISSION_DEFAULTS = {', '\nfunction _pentaCan(key) {');

function buildSandbox(opts) {
  opts = opts || {};
  const state = {
    usersTable: opts.usersTable || [],
    alerts: [],
    modalsAppended: []
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
              if (opts.neverResolves) return new Promise(function () {});
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
          return { select: function () { return { maybeSingle: function () { return Promise.resolve({ data: saved, error: null }); } }; } };
        }
      };
    }
  };
  const sandbox = {
    console, setTimeout, clearTimeout,
    window: { supabaseClient: sb, PentaTenant: { current: function () { return 'biz-fake-1'; } } },
    document: {
      createElement: function () { return { style: {}, appendChild: function () {}, set innerHTML(v) {}, addEventListener: function () {}, querySelectorAll: function () { return []; } }; },
      getElementById: function () { return null; },
      body: { appendChild: function (el) { state.modalsAppended.push(el); } }
    },
    getCurrentAppRole: function () { return opts.viewerRole === undefined ? 'owner' : opts.viewerRole; },
    _pentaParseAuthToken: function () { return { user: { id: opts.viewerAuthId || 'owner-auth-1' } }; },
    alert: function (msg) { state.alerts.push(msg); },
    prompt: function () { return null; }
  };
  vm.createContext(sandbox);
  vm.runInContext(presetSrc, sandbox);
  vm.runInContext(timeoutSrc, sandbox);
  vm.runInContext(blockSrc, sandbox);
  return { sandbox: sandbox, state: state };
}

function fakeEmployee(overrides) {
  return Object.assign({
    id: 'emp-fake-1', legacy_roster_id: 'e_fake_1', name: 'Nadia Fake',
    first_name: 'Nadia', last_name: 'Fake', business_id: 'biz-fake-1',
    phone: null, email: null, auth_user_id: 'nadia-auth-1'
  }, overrides || {});
}

function fakeEls() {
  return {
    wrapEl: { style: {} },
    statusEl: { textContent: '', style: {}, onclick: null },
    toggleWrap: { style: {} },
    toggleEl: { checked: false, disabled: false, onchange: null },
    permLinkEl: { style: {}, textContent: '', onclick: null }
  };
}

async function main() {
  // ---- BUG 2: promoting someone who already has a `users` row
  // (role='employee', the exact Nadia scenario) now gets the Limited
  // preset, not full access. ----
  {
    const { sandbox, state } = buildSandbox({
      usersTable: [{ id: 'u-nadia', auth_user_id: 'nadia-auth-1', business_id: 'biz-fake-1', role: 'employee', manager_permissions: {} }]
    });
    const emp = fakeEmployee();
    const ok = await sandbox._pentaSetManagerAccess(emp, true);
    check('promoting an employee who already has a users row succeeds', ok, true);
    check('role flips to manager', state.usersTable[0].role, 'manager');
    check('she gets the Limited manager preset, not {} (the actual bug)', state.usersTable[0].manager_permissions, sandbox.PRESET_PERMISSIONS.limited_manager);
  }

  // ---- A demote-then-re-promote cycle still restores her prior
  // custom permissions instead of resetting them (unchanged, already
  // covered in Stage 1 -- re-verified here since this exact branch
  // changed). ----
  {
    const { sandbox, state } = buildSandbox({
      usersTable: [{ id: 'u-sarah', auth_user_id: 'sarah-auth-1', business_id: 'biz-fake-1', role: 'employee', manager_permissions: { crm_icon: false } }]
    });
    // She was a manager before (role is 'employee' now because she was
    // demoted), but her manager_permissions from that prior stint are
    // NOT empty -- hasNoSavedPermsYet must be false here.
    const emp = fakeEmployee({ auth_user_id: 'sarah-auth-1', name: 'Sarah Fake' });
    await sandbox._pentaSetManagerAccess(emp, true);
    check('a prior custom permission set survives re-promotion, not reset to Limited', state.usersTable[0].manager_permissions, { crm_icon: false });
  }

  // ---- BUG 1: the modal never hangs silently again -- a stalled
  // network call now shows a clear alert instead of nothing. ----
  {
    const { sandbox, state } = buildSandbox({ neverResolves: true });
    const real = global.setTimeout;
    sandbox.setTimeout = function (fn) { return real(fn, 5); };
    const emp = fakeEmployee();
    await sandbox.openManagerPermissionsModal(emp);
    check('a stalled network call surfaces a visible alert instead of hanging forever', state.alerts.some(function (m) { return /taking too long to respond/i.test(m); }), true);
    check('no modal was ever appended (never a half-open broken state)', state.modalsAppended.length, 0);
  }

  // ---- _renderManagerAccessSection: same timeout treatment, and the
  // current-preset label Tom asked for. ----
  {
    const { sandbox } = buildSandbox({
      usersTable: [{ id: 'u1', auth_user_id: 'nadia-auth-1', business_id: 'biz-fake-1', role: 'manager', manager_permissions: {} }]
    });
    const emp = fakeEmployee();
    const els = fakeEls();
    await sandbox._renderManagerAccessSection(emp, els);
    check('status line shows "Full manager" when nothing is restricted', /Full manager/.test(els.statusEl.textContent), true);
  }
  {
    const { sandbox } = buildSandbox({
      usersTable: [{ id: 'u1', auth_user_id: 'nadia-auth-1', business_id: 'biz-fake-1', role: 'manager', manager_permissions: {} }]
    });
    // Apply the real Limited preset payload so this exercises the
    // actual matcher, not a hand-typed guess at its shape.
    sandbox.usersRow = null;
    const presetPerms = Object.assign({}, sandbox.PRESET_PERMISSIONS.limited_manager);
    const sb2 = buildSandbox({ usersTable: [{ id: 'u1', auth_user_id: 'nadia-auth-1', business_id: 'biz-fake-1', role: 'manager', manager_permissions: presetPerms }] });
    const emp = fakeEmployee();
    const els = fakeEls();
    await sb2.sandbox._renderManagerAccessSection(emp, els);
    check('status line correctly identifies the Limited manager preset', /Limited manager/.test(els.statusEl.textContent), true);
  }
  {
    const { sandbox } = buildSandbox({
      usersTable: [{ id: 'u1', auth_user_id: 'nadia-auth-1', business_id: 'biz-fake-1', role: 'manager', manager_permissions: { see_revenue_total: false } }]
    });
    const emp = fakeEmployee();
    const els = fakeEls();
    await sandbox._renderManagerAccessSection(emp, els);
    check('a hand-tweaked, non-preset-matching set of restrictions shows as "Custom"', /Custom/.test(els.statusEl.textContent), true);
  }
  {
    const { sandbox, state } = buildSandbox({ neverResolves: true });
    const real = global.setTimeout;
    sandbox.setTimeout = function (fn) { return real(fn, 5); };
    const emp = fakeEmployee();
    const els = fakeEls();
    await sandbox._renderManagerAccessSection(emp, els);
    check('a stalled status load shows a retry message, never stuck on "Loading..." forever', /taking too long to respond/i.test(els.statusEl.textContent), true);
  }

  // ---- The button only ever appears for an owner/admin viewer --
  // confirms "a denied role sees no button" and "the button opens the
  // panel" together: hasManagerAccess true + owner viewer => wired;
  // manager viewer => never wired at all. ----
  {
    const { sandbox } = buildSandbox({
      viewerRole: 'owner',
      usersTable: [{ id: 'u1', auth_user_id: 'nadia-auth-1', business_id: 'biz-fake-1', role: 'manager', manager_permissions: {} }]
    });
    const emp = fakeEmployee();
    const els = fakeEls();
    await sandbox._renderManagerAccessSection(emp, els);
    check('owner viewer: the Manage Permissions link is shown', els.permLinkEl.style.display, 'block');
    check('owner viewer: tapping it is wired to openManagerPermissionsModal', typeof els.permLinkEl.onclick, 'function');
  }
  {
    const { sandbox } = buildSandbox({
      viewerRole: 'manager',
      usersTable: [{ id: 'u1', auth_user_id: 'nadia-auth-1', business_id: 'biz-fake-1', role: 'manager', manager_permissions: {} }]
    });
    const emp = fakeEmployee();
    const els = fakeEls();
    await sandbox._renderManagerAccessSection(emp, els);
    check('a denied (plain manager) viewer never sees the link at all', els.permLinkEl.style.display, 'none');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
