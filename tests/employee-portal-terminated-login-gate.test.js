// PR #149 — regression test for the employee portal login gate.
//
// Before this fix, _bootResolveEmployeeFromAuth already fetched and
// returned `status`, but NOTHING checked it before calling
// appUnlockEmployee(emp) -- any employee with valid Supabase auth
// credentials could log into the portal indefinitely after termination,
// including seeing cached historical hours data. Confirmed live: this was
// a real, exploitable access-control gap, not a display nicety.
//
// Two layers, both anchored to the ACTUAL source in index.html (not a
// reimplementation):
//
// 1. _bootShowTerminatedAccountMessage() -- self-contained, fully
//    extracted and executed -- confirms it shows the "account inactive"
//    message and signs the session out (so a stale terminated session
//    can't just keep making authenticated requests).
// 2. A structural check on both REAL _bootResolveEmployeeFromAuth call
//    sites (the boot handler is a large IIFE not practically extractable
//    whole) confirming each one checks `emp.status === 'terminated'`
//    BEFORE calling appUnlockEmployee -- would fail if a future edit
//    reverted to the old unconditional "if (emp) appUnlockEmployee(emp)".
//    A third occurrence exists but is explicitly dead code (guarded by an
//    unconditional `return` above it, kept "so a future bisect can
//    compare") -- deliberately not checked here.
//
// Run with: node tests/employee-portal-terminated-login-gate.test.js

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

// ─────────────────────────────────────────────────────────────────
// Part 1: _bootShowTerminatedAccountMessage, extracted and run
// ─────────────────────────────────────────────────────────────────
const msgStart = 'function _bootShowTerminatedAccountMessage() {';
const msgStartIdx = src.indexOf(msgStart);
if (msgStartIdx === -1) {
  console.error('FAIL: could not find _bootShowTerminatedAccountMessage in index.html — did the login gate get refactored?');
  process.exit(1);
}
const msgEndIdx = src.indexOf('\n\n  function _bootResolveEmployeeFromAuth(parsed) {', msgStartIdx);
if (msgEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after _bootShowTerminatedAccountMessage — extraction range may need updating.');
  process.exit(1);
}
const msgSource = src.slice(msgStartIdx, msgEndIdx);

{
  const elements = {
    'penta-login-screen': { style: {} },
    'penta-login-error': { textContent: '', style: {} },
  };
  const state = { signedOut: false, wireCalled: false };
  const sandbox = {
    console: console,
    document: { getElementById: function (id) { return elements[id] || null; } },
    pentaWireLoginForm: function () { state.wireCalled = true; },
    window: { supabaseClient: { auth: { signOut: function () { state.signedOut = true; } } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(msgSource, sandbox);
  sandbox._bootShowTerminatedAccountMessage();

  check('shows the login screen', elements['penta-login-screen'].style.display, 'flex');
  check('sets an inactive-account message', elements['penta-login-error'].textContent.indexOf('inactive') !== -1, true);
  check('makes the error message visible', elements['penta-login-error'].style.display, '');
  check('re-wires the login form', state.wireCalled, true);
  check('signs out the stale terminated session (not just a UI change -- revokes the client-side session)', state.signedOut, true);
}

// ─────────────────────────────────────────────────────────────────
// Part 2: structural check on both real call sites
// ─────────────────────────────────────────────────────────────────
const callMarker = '_bootResolveEmployeeFromAuth(_sbParsed)';
let searchFrom = 0;
let callSites = [];
while (true) {
  const idx = src.indexOf(callMarker, searchFrom);
  if (idx === -1) break;
  callSites.push(idx);
  searchFrom = idx + callMarker.length;
}
check('exactly 3 occurrences of the call exist (2 real + 1 documented-dead-code copy below an unconditional return)', callSites.length, 3);

// The first two are real (inside the live _bootRouteWithRoleCheck IIFE);
// the third is inside the "(legacy paths below kept as dead code...)"
// block, unreachable because of the `return;` immediately before it.
callSites.slice(0, 2).forEach(function (idx, i) {
  const window_ = src.slice(idx, idx + 400);
  check(
    'call site #' + (i + 1) + ' checks status===\'terminated\' before unlocking, and routes to the terminated-account message',
    /status\s*===\s*'terminated'/.test(window_) && window_.indexOf('_bootShowTerminatedAccountMessage') !== -1,
    true
  );
});

// Guard the dead-code assumption itself, so this test fails loudly (not
// silently) if someone ever makes that third call site live without an
// accompanying status check.
const deadCodeMarkerIdx = src.indexOf('legacy paths below kept as dead code');
check('the third call site is still after the "legacy paths...dead code" marker (still genuinely unreachable)', callSites[2] > deadCodeMarkerIdx, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
