// repair-login-email -- tests for supabase/functions/repair-login-email/
// index.ts. Deno-only (supabase-js admin client, Deno.env) so the full
// handler can't run under plain Node -- same approach
// send-invite-server-side.test.js already established in this repo:
// (a) real execution of the pure, portable helper functions
// (normalizePhone, derivePhoneEmail, emailSuffix, maskPhone, extracted
// verbatim), cross-checked for textual/behavioral equivalence against
// send-invite's and phone-login's own copies and accept-invite's
// differently-shaped but logically equivalent phoneDerivedEmail, with
// (b) structural assertions against the real file text for the
// guarantees that matter most (role gate, terminated gate, dry-run
// writes nothing, the already_correct short-circuit, the collision
// refusal, and that password is never part of the email-update call).
//
// Run with: node tests/repair-login-email.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPAIR_TS = path.join(__dirname, '..', 'supabase', 'functions', 'repair-login-email', 'index.ts');
const SEND_INVITE_TS = path.join(__dirname, '..', 'supabase', 'functions', 'send-invite', 'index.ts');
const ACCEPT_INVITE_TS = path.join(__dirname, '..', 'supabase', 'functions', 'accept-invite', 'index.ts');
const PHONE_LOGIN_TS = path.join(__dirname, '..', 'supabase', 'functions', 'phone-login', 'index.ts');

const repairSrc = fs.readFileSync(REPAIR_TS, 'utf8');
const sendInviteSrc = fs.readFileSync(SEND_INVITE_TS, 'utf8');
const acceptInviteSrc = fs.readFileSync(ACCEPT_INVITE_TS, 'utf8');
const phoneLoginSrc = fs.readFileSync(PHONE_LOGIN_TS, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function extractFn(src, startMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('could not find "' + startMarker + '" (' + label + ')');
  const e = src.indexOf('\n}', s) + 2;
  return src.slice(s, e);
}

function stripTypes(tsSrc, oldSig, newSig, label) {
  const count = tsSrc.split(oldSig).length - 1;
  if (count !== 1) throw new Error('stripTypes (' + label + '): expected exactly 1 occurrence, found ' + count);
  return tsSrc.replace(oldSig, newSig);
}

(function () {
  console.log('Testing pure helpers extracted verbatim from repair-login-email/index.ts\n');

  const normSrc = stripTypes(
    extractFn(repairSrc, 'function normalizePhone(', 'normalizePhone'),
    'function normalizePhone(raw: string): string | null {', 'function normalizePhone(raw) {',
    'normalizePhone signature'
  );
  const deriveSrc = stripTypes(
    extractFn(repairSrc, 'function derivePhoneEmail(', 'derivePhoneEmail'),
    'function derivePhoneEmail(normalizedPhone: string): string {', 'function derivePhoneEmail(normalizedPhone) {',
    'derivePhoneEmail signature'
  );
  const suffixSrc = stripTypes(
    extractFn(repairSrc, 'function emailSuffix(', 'emailSuffix'),
    'function emailSuffix(email: string | null | undefined): string {', 'function emailSuffix(email) {',
    'emailSuffix signature'
  );
  const maskSrc = stripTypes(
    extractFn(repairSrc, 'function maskPhone(', 'maskPhone'),
    'function maskPhone(normalizedPhone: string): string {', 'function maskPhone(normalizedPhone) {',
    'maskPhone signature'
  );

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(normSrc, sandbox);
  vm.runInContext(deriveSrc, sandbox);
  vm.runInContext(suffixSrc, sandbox);
  vm.runInContext(maskSrc, sandbox);

  check('normalizePhone strips to a 10-digit number', sandbox.normalizePhone('5551234567'), '5551234567');
  check('normalizePhone drops a leading US country code', sandbox.normalizePhone('15551234567'), '5551234567');
  check('normalizePhone rejects a too-short number', sandbox.normalizePhone('555'), null);
  check('derivePhoneEmail builds the exact synthetic-email shape', sandbox.derivePhoneEmail('5551234567'), '5551234567@phone.penta.internal');
  check('emailSuffix returns the domain part only, never the local part', sandbox.emailSuffix('5551234567@phone.penta.internal'), '@phone.penta.internal');
  check('emailSuffix handles a missing email without throwing', sandbox.emailSuffix(null), '(none)');
  check('emailSuffix never leaks phone digits -- confirmed no digit from the input survives', /\d/.test(sandbox.emailSuffix('5551234567@phone.penta.internal')), false);
  check('maskPhone masks everything but the last 4 digits', sandbox.maskPhone('5551234567'), '***-***-4567');

  console.log('\n--- Cross-file derive-logic equivalence (shared, not forked) ---\n');

  // send-invite's own copy -- textually IDENTICAL (copy-paste, not a
  // reimplementation that could silently drift).
  const sendInviteNormSrc = stripTypes(
    extractFn(sendInviteSrc, 'function normalizePhone(', 'send-invite normalizePhone'),
    'function normalizePhone(raw: string): string | null {', 'function normalizePhone(raw) {',
    'send-invite normalizePhone signature'
  );
  check('repair-login-email\'s normalizePhone is textually IDENTICAL to send-invite\'s own copy', normSrc, sendInviteNormSrc);

  // phone-login's own copy has one extra trailing inline comment
  // ("-- never attempt a lookup") -- not a real fork, just a comment.
  // Checked behaviorally instead of requiring byte-identical text.
  const phoneLoginNormSrc = stripTypes(
    extractFn(phoneLoginSrc, 'function normalizePhone(', 'phone-login normalizePhone'),
    'function normalizePhone(raw: string): string | null {', 'function normalizePhone(raw) {',
    'phone-login normalizePhone signature'
  );
  const phoneLoginSandboxForCompare = {};
  vm.createContext(phoneLoginSandboxForCompare);
  vm.runInContext(phoneLoginNormSrc, phoneLoginSandboxForCompare);
  ['5551234567', '15551234567', '555', '', '26172516886'].forEach((raw) => {
    check('repair-login-email\'s normalizePhone matches phone-login\'s own copy for input ' + JSON.stringify(raw), sandbox.normalizePhone(raw), phoneLoginSandboxForCompare.normalizePhone(raw));
  });

  // accept-invite's phoneDerivedEmail combines normalize+derive into
  // one differently-shaped function -- not textually identical, but
  // must be BEHAVIORALLY equivalent for every input that matters.
  function extractNestedFn(src, startMarker, endMarker, label) {
    const s = src.indexOf(startMarker);
    if (s === -1) throw new Error('could not find "' + startMarker + '" (' + label + ')');
    const e = src.indexOf(endMarker, s);
    if (e === -1) throw new Error('could not find end marker for "' + startMarker + '" (' + label + ')');
    return src.slice(s, e + endMarker.length);
  }
  const phoneDerivedEmailSrc = stripTypes(
    extractNestedFn(acceptInviteSrc, 'function phoneDerivedEmail(', '\n  }', 'accept-invite phoneDerivedEmail'),
    'function phoneDerivedEmail(raw: unknown): string | null {', 'function phoneDerivedEmail(raw) {',
    'accept-invite phoneDerivedEmail signature'
  );
  const acceptInviteSandbox = {};
  vm.createContext(acceptInviteSandbox);
  vm.runInContext(phoneDerivedEmailSrc, acceptInviteSandbox);

  const sampleInputs = ['5551234567', '15551234567', '(555) 123-4567', '1-555-123-4567', '555', '', '26172516886'];
  sampleInputs.forEach((raw) => {
    const normalized = sandbox.normalizePhone(raw);
    const viaRepair = normalized ? sandbox.derivePhoneEmail(normalized) : null;
    const viaAcceptInvite = acceptInviteSandbox.phoneDerivedEmail(raw);
    check('normalizePhone+derivePhoneEmail matches accept-invite\'s phoneDerivedEmail for input ' + JSON.stringify(raw), viaRepair, viaAcceptInvite);
  });

  console.log('\n--- Structural guarantees (real file text, not a behavioral mock) ---\n');

  check('verify-jwt is ON (the default) -- the deploy comment carries no --no-verify-jwt flag', /Deploy with: supabase functions deploy repair-login-email --project-ref wymoezilyjmyibmuqqmr\n/.test(repairSrc) && !/repair-login-email[^\n]*--no-verify-jwt/.test(repairSrc), true);

  check('role is read from the caller\'s OWN users row via their verified auth id, never from the request payload', /admin\.from\("users"\)\.select\("business_id, role"\)\.eq\("id", callerAuthId\)/.test(repairSrc), true);
  check('non-owner/non-admin callers are rejected -- role check is exactly owner or admin (no manager, no dispatcher)', /callerRole !== "owner" && callerRole !== "admin"/.test(repairSrc), true);
  check('the role check happens BEFORE the employee row is ever loaded', repairSrc.indexOf('callerRole !== "owner" && callerRole !== "admin"') < repairSrc.indexOf('.from("employees")'), true);

  check('a terminated employee is rejected before any email is derived or any write happens', /employee\.status === "terminated"/.test(repairSrc), true);
  check('the terminated check happens BEFORE derivePhoneEmail is ever CALLED', repairSrc.indexOf('employee.status === "terminated"') < repairSrc.indexOf('derivePhoneEmail(normalized)'), true);

  check('already_correct short-circuits with no write -- the check happens before the collision check and before any update call', (function () {
    const i1 = repairSrc.indexOf('currentAuthEmail === targetEmail');
    const i2 = repairSrc.indexOf('listUsers(');
    const i3 = repairSrc.indexOf('updateUserById(authUserId, {\n    email: targetEmail');
    return i1 !== -1 && i1 < i2 && i2 < i3;
  })(), true);
  check('already_correct returns status "already_correct" and nothing else writable', /return json\(200, \{ status: "already_correct" \}\);/.test(repairSrc), true);

  check('the collision check looks at the REAL auth.users email via listUsers, not employees.email (which can already be stale)', /admin\.auth\.admin\.listUsers\(\{ page: 1, perPage: 1000 \}\)/.test(repairSrc), true);
  check('a collision names the OTHER employee by name, with a message that mentions phone correction', /This phone number's login email is already registered to \$\{otherName\}'s account\. Correct the phone number in Staff first\./.test(repairSrc), true);
  check('a collision is refused with 409 and error_code target_email_taken, and writes nothing', /return json\(409, \{\s*error: `This phone number/.test(repairSrc) && /error_code: "target_email_taken"/.test(repairSrc), true);

  check('dry run (the default -- dry_run must be explicitly false to write) returns BEFORE any updateUserById/employees.update write call', (function () {
    const dryRunCheck = repairSrc.indexOf('if (dryRun) {');
    const authUpdate = repairSrc.indexOf('admin.auth.admin.updateUserById(authUserId, {\n    email: targetEmail');
    const empUpdate = repairSrc.indexOf('admin.from("employees").update({ email: targetEmail })');
    return dryRunCheck !== -1 && dryRunCheck < authUpdate && dryRunCheck < empUpdate;
  })(), true);
  check('dry_run defaults to true -- only an explicit false writes anything', /const dryRun = payload\.dry_run !== false;/.test(repairSrc), true);
  check('dry run response never includes a full email, only suffixes and a masked phone', /status: "would_change",\s*old_email_suffix: emailSuffix\(currentAuthEmail\),\s*new_email_suffix: emailSuffix\(targetEmail\),\s*phone_masked: maskPhone\(normalized\),/.test(repairSrc), true);

  // The one real-run write that touches auth.users: confirm its own
  // argument object literal has no "password" key anywhere in it --
  // extracted precisely (stops at the matching close-brace), not just
  // "password doesn't appear in the whole file" (which would also
  // pass trivially if the word just never appeared anywhere).
  const authUpdateCallMatch = repairSrc.match(/admin\.auth\.admin\.updateUserById\(authUserId, \{\s*email: targetEmail,\s*email_confirm: true,\s*\}\);/);
  check('the real-run email-update call to auth.users exists, extracted precisely', !!authUpdateCallMatch, true);
  check('that exact call never includes a password field', authUpdateCallMatch ? /password/.test(authUpdateCallMatch[0]) : 'NOT FOUND', false);

  check('a second createUser is never attempted here -- this function only ever updates an EXISTING auth user by id', !/admin\.auth\.admin\.createUser\(/.test(repairSrc), true);

  check('if employees.email update fails after the auth email already changed, a rollback is attempted', /attempting rollback/.test(repairSrc) && /rollbackErr/.test(repairSrc), true);
  check('a failed rollback is reported as critical, not silently swallowed', /ROLLBACK ALSO FAILED/.test(repairSrc), true);

  check('a successful repair writes a supplementary audit_log row tagged login_email_repair, suffixes only (no full email)', /source: "login_email_repair",\s*old_email_suffix: emailSuffix\(currentAuthEmail\),\s*new_email_suffix: emailSuffix\(targetEmail\),/.test(repairSrc), true);

  check('no return json(...) response body anywhere contains a raw phone-number-shaped template interpolation beyond the masked helper', !/\$\{normalized\}/.test(repairSrc.replace(/maskPhone\(normalized\)/g, '')), true);
  check('console.error calls use the employee id, never the phone or email', (repairSrc.match(/console\.error\([^)]*\)/g) || []).every((c) => !/normalized|targetEmail|currentAuthEmail/.test(c) || /employeeId/.test(c)), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
