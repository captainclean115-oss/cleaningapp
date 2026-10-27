// Invite-collision guard -- unit tests for send-invite/index.ts's
// normalizePhone/derivePhoneEmail/findPhoneCollision, extracted
// VERBATIM from the real .ts source (same discipline every other test
// in this suite uses for index.html's functions). These three
// functions are pure (no I/O, no Deno APIs) -- the only thing that
// needs stripping before they're valid plain JS is their TypeScript
// parameter/return type annotations, done here via exact-match
// string replacement (never a fuzzy regex) so a future signature
// change fails this test loudly instead of silently testing stale
// logic.
//
// Run with: node tests/send-invite-collision.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SEND_INVITE_PATH = path.join(__dirname, '..', 'supabase', 'functions', 'send-invite', 'index.ts');
const tsSrc = fs.readFileSync(SEND_INVITE_PATH, 'utf8');

function extract(src, startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed (' + label + '): could not find start marker: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed (' + label + '): could not find end marker after start: ' + endMarker);
  return src.slice(s, e);
}

function stripSignature(src, oldSig, newSig, label) {
  const count = src.split(oldSig).length - 1;
  if (count !== 1) throw new Error('stripSignature (' + label + '): expected exactly 1 occurrence of the TS signature, found ' + count);
  return src.replace(oldSig, newSig);
}

let logicSrc = extract(
  tsSrc,
  'function normalizePhone(raw: string): string | null {',
  '\n\n// Same 32-random-byte',
  'normalizePhone + derivePhoneEmail + findPhoneCollision'
);

logicSrc = stripSignature(
  logicSrc,
  'function normalizePhone(raw: string): string | null {',
  'function normalizePhone(raw) {',
  'normalizePhone signature'
);
logicSrc = stripSignature(
  logicSrc,
  'function derivePhoneEmail(normalizedPhone: string): string {',
  'function derivePhoneEmail(normalizedPhone) {',
  'derivePhoneEmail signature'
);
logicSrc = stripSignature(
  logicSrc,
  'function findPhoneCollision(\n  targetEmployeeId: string,\n  normalizedPhone: string,\n  allEmployees: Array<{ id: string; first_name?: string | null; last_name?: string | null; phone?: string | null; email?: string | null; auth_user_id?: string | null }>\n): { id: string; first_name: string | null; last_name: string | null } | null {',
  'function findPhoneCollision(targetEmployeeId, normalizedPhone, allEmployees) {',
  'findPhoneCollision signature'
);

// Sanity gate: the stripped source must actually BE valid JS, not
// silently still-broken TS that only fails at some later, confusing
// point.
try {
  // eslint-disable-next-line no-new-func
  new Function(logicSrc);
} catch (e) {
  throw new Error('stripped source is not valid JS (' + e.message + '):\n' + logicSrc);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(logicSrc, sandbox);
const normalizePhone = sandbox.normalizePhone;
const derivePhoneEmail = sandbox.derivePhoneEmail;
const findPhoneCollision = sandbox.findPhoneCollision;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

console.log('--- derivePhoneEmail ---\n');
check('derivePhoneEmail builds the exact synthetic-email shape', derivePhoneEmail('5551234567'), '5551234567@phone.penta.internal');

console.log('\n--- findPhoneCollision ---\n');
{
  const TARGET_ID = 'target-emp-id';

  check('match by derived email (phone differs, email already matches)', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: 'other-1', first_name: 'Ana', last_name: 'A', phone: '9998887777', email: '5551234567@phone.penta.internal', auth_user_id: 'auth-1' },
  ]), { id: 'other-1', first_name: 'Ana', last_name: 'A' });

  check('match by normalized phone (email differs, phone normalizes the same with a leading 1)', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: 'other-2', first_name: 'Ben', last_name: 'B', phone: '15551234567', email: 'ben.b@employees.penta.internal', auth_user_id: 'auth-2' },
  ]), { id: 'other-2', first_name: 'Ben', last_name: 'B' });

  check('terminated-with-login still counts as a collision (status is irrelevant -- only auth_user_id matters)', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: 'other-3', first_name: 'Cara', last_name: 'C', status: 'terminated', phone: '5551234567', email: 'stale@phone.penta.internal', auth_user_id: 'auth-3' },
  ]), { id: 'other-3', first_name: 'Cara', last_name: 'C' });

  check('no false match when the other row has no login at all (auth_user_id null)', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: 'other-4', first_name: 'Dee', last_name: 'D', phone: '5551234567', email: 'dee.d@employees.penta.internal', auth_user_id: null },
  ]), null);

  check('no false match when auth_user_id is simply absent from the row', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: 'other-5', first_name: 'Eve', last_name: 'E', phone: '5551234567', email: 'eve.e@employees.penta.internal' },
  ]), null);

  check('same employee re-invite is not a collision, even though her own row matches on both phone and email', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: TARGET_ID, first_name: 'Target', last_name: 'Self', phone: '5551234567', email: '5551234567@phone.penta.internal', auth_user_id: 'auth-target' },
  ]), null);

  check('no match at all when nothing lines up', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: 'other-6', first_name: 'Fay', last_name: 'F', phone: '4445556666', email: 'fay.f@employees.penta.internal', auth_user_id: 'auth-6' },
  ]), null);

  check('returns the FIRST colliding row\'s id/name when multiple rows are present', findPhoneCollision(TARGET_ID, '5551234567', [
    { id: 'other-7', first_name: 'Gus', last_name: 'G', phone: '4445556666', email: 'gus.g@employees.penta.internal', auth_user_id: 'auth-7' },
    { id: 'other-8', first_name: 'Hal', last_name: 'H', phone: '5551234567', email: 'hal.h@employees.penta.internal', auth_user_id: 'auth-8' },
  ]), { id: 'other-8', first_name: 'Hal', last_name: 'H' });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
