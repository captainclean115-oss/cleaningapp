// PR #147 — regression test locking in the guarantee that every field the
// client edit modal (saveClientEdit) can write actually reaches the
// Supabase clients table, closing the exact bug class PR #138 found
// (current_price silently written to a dead localStorage key instead of
// the real payload). This test would have caught that bug immediately
// instead of needing a full diagnosis pass.
//
// Two layers, both extracted and run from the ACTUAL source in index.html
// (not a reimplementation):
//
// 1. saveClientEdit's DOM-reading/editPatch-construction prefix, run with
//    a fully-stubbed DOM covering every ce-* field the modal exposes, to
//    prove the constructed patch actually contains every field with the
//    value the user entered. Extraction stops right after the real
//    PentaClients.updateClient(clientId, editPatch) call -- everything
//    after that in the real function is unrelated side-work (job-regen,
//    localStorage mirrors, the TMConnect pending log) that doesn't bear on
//    whether the DB write payload is complete, so the extracted source is
//    truncated there and closed with an artificial trailing brace. This is
//    still the real production code up to that point, not a
//    reimplementation of it.
//
// 2. _transformRowForWrite, checked against the full set of keys
//    saveClientEdit's editPatch can contain -- confirms every one of them
//    has a mapping to a real Supabase column, not just the ones tested in
//    isolation by PR #138/#139's narrower tests.
//
// Run with: node tests/client-edit-all-fields-persist.test.js

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
// Layer 1: saveClientEdit's editPatch construction, DOM-stubbed
// ─────────────────────────────────────────────────────────────────
const seStart = 'function saveClientEdit(clientId) {';
const seStartIdx = src.indexOf(seStart);
if (seStartIdx === -1) {
  console.error('FAIL: could not find saveClientEdit in index.html — did it get renamed/refactored?');
  process.exit(1);
}
const seEndMarker = 'PentaClients.updateClient(clientId, editPatch);';
const seEndIdx = src.indexOf(seEndMarker, seStartIdx);
if (seEndIdx === -1) {
  console.error('FAIL: could not find the PentaClients.updateClient(clientId, editPatch) call — did the write call move/change shape?');
  process.exit(1);
}
const seSource = src.slice(seStartIdx, seEndIdx + seEndMarker.length) + '\n}';

function buildSaveClientEditSandbox(domValues, existingClient) {
  const state = { updateClientCalls: [] };
  const elements = {};
  Object.keys(domValues).forEach(function (id) {
    elements[id] = { value: domValues[id] };
  });
  const sandbox = {
    console: console,
    document: {
      getElementById: function (id) { return elements[id] || null; },
      querySelectorAll: function () { return { forEach: function () {} }; }, // no pref-day chips selected in these tests
    },
    _cePhones: [{ name: '', number: '555-0100', primary: true }],
    PREF_DAY_ORDER: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    prefDayPack: function (days) { return days.join(','); },
    PentaClients: {
      getClient: function () { return existingClient; },
      clearField: function () {},
      updateClient: function (id, patch) { state.updateClientCalls.push({ id: id, patch: patch }); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(seSource, sandbox);
  sandbox.saveClientEdit('client-1');
  return state;
}

{
  const existingClient = { id: 'client-1', fn: 'Old', ln: 'Name', addr: '1 Old St', city: 'OldTown', zip: '00000', next: null, anchor: null, fc: 'RMS-WEK', status: 'active' };
  const domValues = {
    'ce-fn': 'Jane', 'ce-ln': 'Doe', 'ce-em': 'jane@example.com',
    'ce-addr': '42 New Ave', 'ce-city': 'Newville', 'ce-zip': '02101',
    'ce-notes': 'gate code 1234', 'ce-pkg': 'Deluxe',
    'ce-freq': 'RMS-EOW', 'ce-pref-time': 'afternoon', 'ce-anchor': '2026-09-15',
    'ce-estimated-minutes': '240', 'ce-price': '$275', 'ce-sqft': '2100',
  };
  const state = buildSaveClientEditSandbox(domValues, existingClient);
  check('PentaClients.updateClient is called exactly once', state.updateClientCalls.length, 1);
  const patch = state.updateClientCalls[0] ? state.updateClientCalls[0].patch : {};
  check('fn reaches the write payload', patch.fn, 'Jane');
  check('ln reaches the write payload', patch.ln, 'Doe');
  check('ph (from the phone list, not a plain ce-ph field) reaches the write payload', patch.ph, '555-0100');
  check('em reaches the write payload', patch.em, 'jane@example.com');
  check('addr reaches the write payload', patch.addr, '42 New Ave');
  check('city reaches the write payload', patch.city, 'Newville');
  check('zip reaches the write payload', patch.zip, '02101');
  check('notes reaches the write payload', patch.notes, 'gate code 1234');
  check('pkg reaches the write payload', patch.pkg, 'Deluxe');
  check('fc (frequency) reaches the write payload', patch.fc, 'RMS-EOW');
  check('pref_time reaches the write payload', patch.pref_time, 'afternoon');
  check('estimated_minutes reaches the write payload as a number (PR #139)', patch.estimated_minutes, 240);
  check('current_price reaches the write payload as a number, $ and commas stripped (PR #138)', patch.current_price, 275);
  check('sqft reaches the write payload as a number (PR #148)', patch.sqft, 2100);
  check('entering a sqft value marks the source manual (PR #148, protects it from auto-enrichment overwrite)', patch.sqft_source, 'manual');
}

// A blank/cleared price and estimated_minutes must write null, not be
// dropped or coerced to 0/NaN -- exactly the failure mode PR #138 found
// (a cleared field silently not persisting is as bad as one that never did).
{
  const existingClient = { id: 'client-1', fn: 'Jane', ln: 'Doe', addr: '', city: '', zip: '', next: null, anchor: null, fc: 'RMS-WEK', status: 'active' };
  const domValues = {
    'ce-fn': 'Jane', 'ce-ln': 'Doe', 'ce-em': '', 'ce-addr': '', 'ce-city': '', 'ce-zip': '',
    'ce-notes': '', 'ce-pkg': '', 'ce-freq': 'RMS-WEK', 'ce-pref-time': '', 'ce-anchor': '',
    'ce-estimated-minutes': '', 'ce-price': '', 'ce-sqft': '',
  };
  const state = buildSaveClientEditSandbox(domValues, existingClient);
  const patch = state.updateClientCalls[0].patch;
  check('clearing the price field writes null, not 0/NaN/undefined', patch.current_price, null);
  check('clearing estimated minutes writes null', patch.estimated_minutes, null);
  check('clearing sqft writes null (PR #148)', patch.sqft, null);
  check('clearing sqft releases the source back to unknown, re-eligible for auto-enrichment (PR #148)', patch.sqft_source, 'unknown');
}

// ─────────────────────────────────────────────────────────────────
// Layer 2: every key editPatch can contain has a real column mapping
// ─────────────────────────────────────────────────────────────────
const trwStart = 'function _normalizeFreqCode(v) {';
const trwStartIdx = src.indexOf(trwStart);
if (trwStartIdx === -1) {
  console.error('FAIL: could not find _normalizeFreqCode in index.html — did PentaClients get refactored?');
  process.exit(1);
}
const trwEndIdx = src.indexOf('\n  function _norm(v) {', trwStartIdx);
if (trwEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after _transformRowForWrite — extraction range may need updating.');
  process.exit(1);
}
const trwSource = src.slice(trwStartIdx, trwEndIdx);
const trwSandbox = { console: console };
vm.createContext(trwSandbox);
vm.runInContext(trwSource, trwSandbox);

// Every key saveClientEdit's editPatch can carry (read directly off the
// object literal + the conditional status/pause/geocode additions).
const EDIT_PATCH_KEYS = [
  'fn', 'ln', 'ph', 'em', 'addr', 'city', 'zip', 'notes', 'pkg', 'fc',
  'pref_day', 'pref_time', 'estimated_minutes', 'current_price', 'anchor',
  'geocode_status', 'lat', 'lng',
  'status', 'pause_start', 'pause_end', 'pause_reason', 'status_changed_at',
  'sqft', 'sqft_source', 'sqft_from_records',
];
EDIT_PATCH_KEYS.forEach(function (key) {
  const probe = {};
  probe[key] = 'PROBE_VALUE_' + key;
  const out = trwSandbox._transformRowForWrite(probe);
  check('_transformRowForWrite has a mapping for editPatch key "' + key + '"', Object.keys(out).length > 0, true);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
