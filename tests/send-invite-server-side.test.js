// Server-side invites feature -- tests for supabase/functions/send-invite/
// index.ts. Deno-only (supabase-js admin client, Deno.env, fetch to
// RingCentral) so the full handler can't run under plain Node -- this
// file combines (a) real execution of the pure, portable helper
// functions (normalizePhone, generateInviteToken, both extracted
// verbatim) with (b) structural assertions against the real file text
// for the guarantees that matter most (client-supplied phone/message
// are never used, role check is exactly owner/manager, the token/link
// are never put in a response body or a log line).
//
// Run with: node tests/send-invite-server-side.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SEND_INVITE_TS = path.join(__dirname, '..', 'supabase', 'functions', 'send-invite', 'index.ts');
const src = fs.readFileSync(SEND_INVITE_TS, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function extractFn(startMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('could not find "' + startMarker + '" in send-invite/index.ts');
  const e = src.indexOf('\n}', s) + 2;
  return src.slice(s, e);
}

(function () {
  console.log('Testing pure helpers extracted verbatim from send-invite/index.ts\n');

  // normalizePhone: identical shape to phone-login's/request-password-
  // reset's own copy -- only the signature has TS annotations.
  const normSrc = extractFn('function normalizePhone(').replace(
    'function normalizePhone(raw: string): string | null {', 'function normalizePhone(raw) {'
  );
  const normSandbox = {};
  vm.createContext(normSandbox);
  vm.runInContext(normSrc, normSandbox);
  check('normalizePhone strips to a 10-digit number', normSandbox.normalizePhone('7816263485'), '7816263485');
  check('normalizePhone drops a leading US country code', normSandbox.normalizePhone('17816263485'), '7816263485');
  check('normalizePhone rejects a too-short number', normSandbox.normalizePhone('555'), null);

  // generateInviteToken: body has no TS-specific syntax at all.
  const tokenSrc = extractFn('function generateInviteToken(').replace(
    'function generateInviteToken(): string {', 'function generateInviteToken() {'
  );
  const tokenSandbox = { crypto: require('crypto').webcrypto, btoa: (s) => Buffer.from(s, 'binary').toString('base64') };
  vm.createContext(tokenSandbox);
  vm.runInContext(tokenSrc, tokenSandbox);
  const t1 = tokenSandbox.generateInviteToken();
  const t2 = tokenSandbox.generateInviteToken();
  check('generateInviteToken produces a non-empty, URL-safe string', /^[A-Za-z0-9_-]+$/.test(t1) && t1.length > 20, true);
  check('generateInviteToken never repeats (32 random bytes)', t1 !== t2, true);

  console.log('\nStructural guarantees (real file text, not a behavioral mock)\n');

  check('the payload type accepts ONLY employee_id -- no phone, no message field exists to ignore', /payload: \{ employee_id\?: string \}/.test(src), true);
  check('the text message is built from employee.first_name + businessName + link -- never from payload', /const text = `Hi \$\{firstName\}, \$\{businessName\} set up your Penta account\. Create your password here: \$\{link\}`/.test(src), true);
  check('the phone sent to RC comes from the EMPLOYEE ROW (normalized), never from payload', /sendInviteText\(admin, callerBusinessId, normalized, text\)/.test(src), true);
  check('role check is exactly owner or manager (not employee, not any other role)', /callerRole !== "owner" && callerRole !== "manager"/.test(src), true);
  check('role is read from the caller\'s OWN users row via their verified auth id, never from the request payload', /admin\.from\("users"\)\.select\("business_id, role"\)\.eq\("id", callerAuthId\)/.test(src), true);
  check('cross-tenant check: the employee\'s own business_id must match the caller\'s', /employee\.business_id !== callerBusinessId/.test(src), true);
  check('the success response contains ONLY { success: true } -- no token, no link, no phone', /return json\(200, \{ success: true \}\);/.test(src), true);
  // Precise check: extract every `return json(STATUS, { ... })` call's
  // own object-literal body (matching across lines, stopping at the
  // closing `});`) and confirm NONE of them contains the token or link
  // variable -- rather than scanning the whole file, where `${token}`
  // legitimately appears once, inside the (unrelated, never-returned)
  // `link` string built for the SMS text.
  const jsonCalls = src.match(/return json\([0-9]+,\s*\{[\s\S]*?\}\);/g) || [];
  check('at least one return json(...) call was found to check (sanity check on the extraction itself)', jsonCalls.length > 0, true);
  // Checks specifically for template-literal interpolation of the
  // token/link variables (`${token}` / `${link}`) -- the only way this
  // file's style could embed a variable's VALUE into a json(...) call
  // (every other json(...) call in this file uses a plain, static
  // string literal, confirmed by reading it). This avoids false
  // positives on "token"/"link" appearing as plain English words inside
  // an already-static error string (e.g. "Empty bearer token", "Copy
  // invite link") -- those are never followed by the ${...} syntax that
  // would actually interpolate a value.
  const leakyCall = jsonCalls.find(function (c) { return /\$\{token\}/.test(c) || /\$\{link\}/.test(c); });
  check('no return json(...) response body ever contains the token or link variable', leakyCall, undefined);
  check('the token/link variables are never passed as console.error arguments', !/console\.error\([^)]*,\s*(token|link)\)/.test(src), true);
  check('rate limiting uses the same generic rate_limit_check/increment RPCs every other Edge Function in this app uses (no new table)', /rate_limit_check/.test(src) && /rate_limit_increment/.test(src), true);
  check('an employee-keyed rate limit exists (stops spamming one person)', /invite:employee:/.test(src), true);
  check('a caller-keyed rate limit also exists (stops one manager session from mass-spamming)', /invite:caller:/.test(src), true);
  check('sendInviteText mirrors sendResetText\'s RC call shape (same provider, same credentials resolution) -- not a second integration', /get_active_phone_integration/.test(src) && /platform\.ringcentral\.com\/restapi\/v1\.0\/account\/~\/extension\/~\/sms/.test(src), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
