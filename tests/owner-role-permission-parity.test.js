// Regression test: does role='owner' get at least everything role='manager'
// gets (Terminate Employee button, admin sections, every manager-tier
// data-permission)?
//
// Prompted by a report that the Terminate Employee button was invisible,
// with the theory that some permission check requires role==='manager'
// exactly and excludes 'owner' (which should be a strict superset).
//
// Diagnosis found no such check exists. No function named canEditTeams
// exists anywhere in this codebase. Every role-gating path that was found
// (isManagerRole, getCurrentAppRole's routing, getPermissions) treats
// 'owner'/'admin' as equal-or-greater than 'manager', with owner getting
// unconditional all-true permissions regardless of any per-manager
// restriction stored in manager_permissions. The Terminate Employee
// button itself (index.html ~5166/~51183) has no data-permission
// attribute at all -- its visibility is unconditional once the employee
// edit modal is open, so it was never role-gated in the first place.
//
// The actual root cause of the original report was a z-index stacking bug
// (PR #146, terminate-modal-zindex-stacking.test.js) -- the confirmation
// modal rendered behind the still-open parent modal, for every role.
//
// This file guards against a FUTURE regression where owner permissions
// get narrowed below manager's (e.g. someone "simplifies" getPermissions
// by merging the owner and manager branches and accidentally applies a
// DB-stored manager_permissions restriction to owner too).
//
// Run with: node tests/owner-role-permission-parity.test.js

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

const defaultPerms = extract('var DEFAULT_PERMISSIONS = {', '\nfunction getPermissions()', 'DEFAULT_PERMISSIONS');
const getPermissionsFn = extract('function getPermissions() {', '\nfunction setPermission(', 'getPermissions');
const isManagerRoleFn = extract('function isManagerRole() {', '\n\n// Hook the existing onAuthStateChange', 'isManagerRole');
const getCurrentAppRoleFn = extract('function getCurrentAppRole() {', '\n\n// Convenience: matches the manager-equivalent', 'getCurrentAppRole');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

check('no canEditTeams function exists in index.html (confirms the Terminate button is not gated by a role check with this or a similarly-named function)', /function\s+canEditTeams\s*\(/.test(src), false);
check('the Terminate Employee button markup has no data-permission attribute (its visibility was never role-gated -- the original bug was CSS stacking, not permissions)', /id="main-emp-delete"[^>]*>/.exec(src)[0].indexOf('data-permission') !== -1, false);

function permsForRole(role, dbManagerPerms) {
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    getCurrentAppRole: () => role,
    getCachedManagerPermissions: () => dbManagerPerms || {},
  };
  vm.createContext(sandbox);
  vm.runInContext(defaultPerms + '\n' + getPermissionsFn, sandbox);
  return sandbox.getPermissions();
}

function isManagerRoleFor(role) {
  const sandbox = {
    console,
    _pentaParseAuthToken: () => ({ user: { id: 'u1', user_metadata: {} } }),
    _pentaCachedRole: role,
    _pentaCachedRoleUserId: 'u1',
    _pentaResolveRoleFromDB: () => Promise.resolve(role),
  };
  vm.createContext(sandbox);
  vm.runInContext(getCurrentAppRoleFn + '\n' + isManagerRoleFn, sandbox);
  return sandbox.isManagerRole();
}

// The core parity assertion: every manager-tier permission key that's
// true by default must ALSO be true for owner -- even when a manager has
// been explicitly restricted via manager_permissions.
const managerDefaultKeys = Object.keys(JSON.parse(
  JSON.stringify(vm.runInNewContext(defaultPerms + '\nDEFAULT_PERMISSIONS.manager'))
));
const ownerPermsWithManagerRestricted = permsForRole('owner', (function () {
  const restricted = {};
  managerDefaultKeys.forEach(k => { restricted[k] = false; });
  return restricted;
})());
managerDefaultKeys.forEach(function (key) {
  check('owner keeps "' + key + '" = true even when manager_permissions restricts it for managers (owner cannot be restricted by manager-tier settings)', ownerPermsWithManagerRestricted.manager[key], true);
});

check('isManagerRole() is true for owner', isManagerRoleFor('owner'), true);
check('isManagerRole() is true for admin', isManagerRoleFor('admin'), true);
check('isManagerRole() is true for manager', isManagerRoleFor('manager'), true);
check('isManagerRole() is false for employee (regular staff should not see manager admin sections)', isManagerRoleFor('employee'), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
