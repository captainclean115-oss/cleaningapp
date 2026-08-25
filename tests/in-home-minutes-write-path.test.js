// PR #144 — regression test for the clients.estimated_minutes read/write
// mapping in PentaClients (in-home minutes ÷ team size feature).
//
// This field's save path was VERIFIED working (not fixed) during PR #144 —
// unlike the PR #138 current_price bug, saveClientEdit's editPatch already
// included estimated_minutes and _transformRowForWrite already mapped it,
// confirmed live against Supabase (insert/update/readback/delete on a
// disposable client row). This test guards that mapping against a future
// regression of the same silent-drop bug class (PR #88/#138): a field
// present in the JS patch but missing from _transformRowForWrite is
// silently dropped from the outgoing Supabase payload with no error.
//
// Extracted and run from the ACTUAL _transformRow/_transformRowForWrite
// source in index.html (not a reimplementation).
//
// Run with: node tests/in-home-minutes-write-path.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'function _normalizeFreqCode(v) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find _normalizeFreqCode in index.html — did PentaClients get refactored?');
  process.exit(1);
}
const endMarker = '\n  function _norm(v) {';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after _transformRowForWrite — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const sandbox = { console: console };
vm.createContext(sandbox);
vm.runInContext(fnSource, sandbox);

// --- Read direction: DB row -> JS object ---
check(
  'read: a numeric estimated_minutes DB value round-trips as a Number',
  sandbox._transformRow({ external_id: '1', estimated_minutes: 300 }).estimated_minutes,
  300
);
check(
  'read: a null estimated_minutes DB value stays null (not 0 or NaN)',
  sandbox._transformRow({ external_id: '1', estimated_minutes: null }).estimated_minutes,
  null
);
check(
  'read: estimated_minutes absent from the row entirely still resolves to null',
  sandbox._transformRow({ external_id: '1' }).estimated_minutes,
  null
);

// --- Write direction: JS patch -> Supabase payload ---
check(
  'write: a numeric estimated_minutes patch is included in the outgoing payload',
  sandbox._transformRowForWrite({ estimated_minutes: 300 }),
  { estimated_minutes: 300 }
);
check(
  'write: clearing the field (null) writes null, not dropping the key',
  sandbox._transformRowForWrite({ estimated_minutes: null }),
  { estimated_minutes: null }
);
check(
  'write: an empty-string input (blank form field) normalizes to null',
  sandbox._transformRowForWrite({ estimated_minutes: '' }),
  { estimated_minutes: null }
);
check(
  'write: a numeric-string input (from a DOM input.value) coerces to a Number',
  sandbox._transformRowForWrite({ estimated_minutes: '180' }),
  { estimated_minutes: 180 }
);
check(
  'write: a fractional minutes value rounds to the nearest whole minute',
  sandbox._transformRowForWrite({ estimated_minutes: 100.6 }),
  { estimated_minutes: 101 }
);
check(
  'write: estimated_minutes key entirely absent from the patch is NOT invented in the payload (guards the PR #88/#138 silent-drop bug class in the opposite direction — no phantom writes)',
  Object.prototype.hasOwnProperty.call(sandbox._transformRowForWrite({ fn: 'Test' }), 'estimated_minutes'),
  false
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
