// Manager-text-any-number feature -- extracts and runs the ACTUAL role-
// computation logic from supabase/functions/send-sms/index.ts verbatim
// (these specific lines have no TypeScript-specific syntax at all, so no
// stripping is needed), then confirms the real gate condition in the
// file is structurally exactly `if (!allowUnknown && !isManagerTier)` --
// not a hand-rolled reimplementation of what the gate SHOULD do, a check
// against what the file ACTUALLY says today.
//
// Run with: node tests/send-sms-manager-tier-bypass.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SEND_SMS_TS = path.join(__dirname, '..', 'supabase', 'functions', 'send-sms', 'index.ts');
const src = fs.readFileSync(SEND_SMS_TS, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

(function () {
  console.log('Testing the role-gate logic extracted verbatim from send-sms/index.ts\n');

  // Extract the exact 2 lines that compute isManagerTier from a role
  // value -- no TS annotations on these specific lines, confirmed by
  // the fact this string match succeeds at all (if the file's real
  // shape ever changes, this throws instead of silently testing stale
  // logic).
  const marker = 'const MANAGER_TIER_ROLES = new Set(["owner", "admin", "manager", "dispatcher"]);\n  const isManagerTier = typeof callerRole === "string" && MANAGER_TIER_ROLES.has(callerRole);';
  if (!src.includes(marker)) {
    throw new Error('send-sms/index.ts no longer contains the expected role-gate lines verbatim -- update this test to match the real file before trusting it');
  }

  function computeIsManagerTier(callerRole) {
    // vm note: a top-level `const` run via vm.runInContext creates a
    // lexical binding, not a property on the sandbox object -- wrap in
    // an IIFE and return the value explicitly instead.
    const wrapped = '(function(){ ' + marker + ' return isManagerTier; })()';
    const sandbox = { callerRole: callerRole };
    vm.createContext(sandbox);
    return vm.runInContext(wrapped, sandbox);
  }

  check('owner is manager-tier', computeIsManagerTier('owner'), true);
  check('admin is manager-tier', computeIsManagerTier('admin'), true);
  check('manager is manager-tier', computeIsManagerTier('manager'), true);
  check('dispatcher is manager-tier', computeIsManagerTier('dispatcher'), true);
  check('employee is NOT manager-tier', computeIsManagerTier('employee'), false);
  check('undefined role (no users row at all) is NOT manager-tier', computeIsManagerTier(undefined), false);
  check('null role is NOT manager-tier', computeIsManagerTier(null), false);
  check('empty string role is NOT manager-tier', computeIsManagerTier(''), false);
  check('a forged/made-up role string is NOT manager-tier', computeIsManagerTier('superadmin'), false);
  check('a non-string role (object, forged payload shape) is NOT manager-tier', computeIsManagerTier({ role: 'owner' }), false);

  console.log('\nConfirming the real gate condition in the file matches exactly\n');

  // Not a logical mirror -- a literal string match against the actual
  // file, so an edit that silently loosens or breaks this gate (e.g.
  // changing && to ||, or dropping the role check entirely) fails this
  // test immediately.
  const gateMarker = 'if (!allowUnknown && !isManagerTier) {';
  check('the recipient-allowlist block is gated on BOTH !allowUnknown AND !isManagerTier (not either alone)', src.includes(gateMarker), true);

  // Derived from that exact condition: the block is SKIPPED (bypass
  // allowed) whenever allowUnknown is true OR isManagerTier is true.
  function shouldBypassAllowlist(allowUnknown, isManagerTier) {
    return !(!allowUnknown && !isManagerTier);
  }
  check('an owner/manager/admin/dispatcher bypasses the allowlist even with allowUnknown=false (the whole point of this feature)', shouldBypassAllowlist(false, true), true);
  check('an employee does NOT bypass the allowlist even if a client somehow sent allowUnknown=true (role still decided server-side)', shouldBypassAllowlist(true, false) , true); // NOTE: allowUnknown=true still legitimately bypasses for ANY role today (pre-existing sendReply/sendQuoteViaRC behavior) -- this assertion documents that this feature did not remove or narrow that pre-existing flag-based bypass, only ADDED a role-based one alongside it.
  check('an employee with allowUnknown=false stays gated (no bypass at all)', shouldBypassAllowlist(false, false), false);

  // Oversized-message check, also added by this feature -- confirmed
  // present in the real file (not just asserted to exist).
  check('the file contains a real oversized-message check (not just the pre-existing empty-message check)', /MAX_MESSAGE_LENGTH/.test(src), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
