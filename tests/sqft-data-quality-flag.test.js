// PR #148 — regression tests for the sqft data-quality flag feature.
//
// Covers two things extracted and run from the ACTUAL source in index.html
// (not a reimplementation):
//
// 1. _sqftMismatchInfo() -- the shared >10% mismatch formula used by the
//    client card badge (and mirrored, necessarily, in SQL by
//    flag_sqft_discrepancies() in migration 103 -- there's no shared
//    runtime between JS and Postgres, so that one formula genuinely has
//    to exist twice; this test locks in what the JS side must match).
//    Covers the spec's exact test-plan scenarios plus its own worked
//    example (manual 2100 vs records 3400 -> 62%).
//
// 2. maidsEnrichMissingSqft() -- the background MassGIS enrichment job.
//    Before this PR, its candidate filter (`c.sqft == null`) was ALWAYS
//    true because PentaClients._transformRow never mapped `sqft` onto the
//    in-memory client object, so every re-run could silently overwrite a
//    manually-entered sqft. This test proves the fixed three-way branch:
//    fill when empty, refresh when previously auto-derived, and NEVER
//    overwrite (only record sqft_from_records) when the source is manual.
//
// Run with: node tests/sqft-data-quality-flag.test.js

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
// Part 1: _sqftMismatchInfo
// ─────────────────────────────────────────────────────────────────
const infoStart = 'function _sqftMismatchInfo(c) {';
const infoStartIdx = src.indexOf(infoStart);
if (infoStartIdx === -1) {
  console.error('FAIL: could not find _sqftMismatchInfo in index.html — did it get renamed/refactored?');
  process.exit(1);
}
const infoEndIdx = src.indexOf('\n\nconst AV_COLORS', infoStartIdx);
if (infoEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after _sqftMismatchInfo — extraction range may need updating.');
  process.exit(1);
}
const infoSandbox = {};
vm.createContext(infoSandbox);
vm.runInContext(src.slice(infoStartIdx, infoEndIdx), infoSandbox);

check('spec test plan: manual 2000 vs records 2500 (25% diff) -> flagged',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'manual', sqft: 2000, sqft_from_records: 2500 }).flagged, true);
check('spec test plan: manual 2000 vs records 2100 (5% diff) -> NOT flagged',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'manual', sqft: 2000, sqft_from_records: 2100 }).flagged, false);
check('spec test plan: manual sqft only, no records -> NOT flagged (no basis for comparison)',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'manual', sqft: 2000, sqft_from_records: null }).flagged, false);
check('spec test plan: auto-enriched sqft only, no manual -> NOT flagged',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'auto', sqft: 2200, sqft_from_records: null }).flagged, false);
check('spec worked example: manual 2100 vs records 3400 -> flagged at 62%',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'manual', sqft: 2100, sqft_from_records: 3400 }),
  { flagged: true, pct: 62 });
check('exactly at the 10% boundary is NOT flagged (threshold is "more than 10%", not "10% or more")',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'manual', sqft: 1000, sqft_from_records: 1100 }).flagged, false);
check('just over the 10% boundary IS flagged',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'manual', sqft: 1000, sqft_from_records: 1101 }).flagged, true);
check('unknown source with both values present -> NOT flagged (must be manual specifically)',
  infoSandbox._sqftMismatchInfo({ sqft_source: 'unknown', sqft: 2000, sqft_from_records: 2500 }).flagged, false);
check('null client -> NOT flagged, no throw', infoSandbox._sqftMismatchInfo(null).flagged, false);

// ─────────────────────────────────────────────────────────────────
// Part 2: maidsEnrichMissingSqft
// ─────────────────────────────────────────────────────────────────
const enrichStart = 'async function maidsEnrichMissingSqft() {';
const enrichStartIdx = src.indexOf(enrichStart);
if (enrichStartIdx === -1) {
  console.error('FAIL: could not find maidsEnrichMissingSqft in index.html — did it get refactored?');
  process.exit(1);
}
const enrichEndIdx = src.indexOf('\n\nasync function openMaidsPastImports() {', enrichStartIdx);
if (enrichEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after maidsEnrichMissingSqft — extraction range may need updating.');
  process.exit(1);
}
const enrichSource = src.slice(enrichStartIdx, enrichEndIdx);

function buildEnrichSandbox(clients, lookupResults) {
  const updates = []; // { id, patch }
  const state = { updates: updates };
  // A from('clients') stub whose chain matches the real call shape used by
  // the source: sb.from('clients').update({...}).eq('id',...).eq('business_id',...)
  // (awaited directly -- the source does `await sb.from(...).update(...).eq(...).eq(...)`,
  // so the chain's final link just needs to be thenable).
  function fromClients() {
    return {
      update: function (patch) {
        var lastId = null;
        var chain = {
          eq: function (col, val) { if (col === 'id') lastId = val; return chain; },
          then: function (resolve) { updates.push({ id: lastId, patch: patch }); resolve({ data: null, error: null }); },
        };
        return chain;
      },
      select: function () {
        return {
          eq: function () { return this; },
          maybeSingle: function () { return Promise.resolve({ data: { review_flags: [] }, error: null }); },
        };
      },
    };
  }
  const sandbox = {
    console: console,
    setTimeout: function (fn) { fn(); }, // skip the real 300ms pacing delay in tests
    document: { getElementById: function () { return null; } },
    maidsLookupSqft: function (addr) { return Promise.resolve(lookupResults[addr] !== undefined ? lookupResults[addr] : null); },
    window: {
      supabaseClient: { from: fromClients },
      PentaTenant: { current: function () { return 'biz-1'; } },
      PentaClients: { list: function () { return clients; }, refreshFromSupabase: function () { return Promise.resolve(); } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(enrichSource, sandbox);
  return { sandbox: sandbox, state: state };
}

(async function () {
  // Client with no sqft at all -- safe to fill in from the fresh lookup.
  {
    const clients = [{ id: 'c1', uuid: 'u1', addr: '1 Main St', city: 'X', zip: '00000', sqft: null, sqft_source: 'unknown', sqft_from_records: null }];
    const { sandbox, state } = buildEnrichSandbox(clients, { '1 Main St': { sqft: 1800 } });
    await sandbox.maidsEnrichMissingSqft();
    const u = state.updates.find(function (x) { return x.id === 'u1'; });
    check('no prior sqft: fills sqft from the lookup', u.patch.sqft, 1800);
    check('no prior sqft: marks source auto', u.patch.sqft_source, 'auto');
    check('no prior sqft: also records sqft_from_records', u.patch.sqft_from_records, 1800);
  }

  // Client with a previously auto-derived sqft -- safe to refresh.
  {
    const clients = [{ id: 'c2', uuid: 'u2', addr: '2 Oak St', city: 'X', zip: '00000', sqft: 1500, sqft_source: 'auto', sqft_from_records: null }];
    const { sandbox, state } = buildEnrichSandbox(clients, { '2 Oak St': { sqft: 1650 } });
    await sandbox.maidsEnrichMissingSqft();
    const u = state.updates.find(function (x) { return x.id === 'u2'; });
    check('previously auto-derived sqft is refreshed to the new lookup value', u.patch.sqft, 1650);
    check('stays tagged auto after refresh', u.patch.sqft_source, 'auto');
  }

  // Client with a MANUAL sqft -- must NEVER be overwritten, only recorded for comparison.
  // This is the exact bug PR #148 fixed: before the _transformRow fix,
  // c.sqft was always undefined so this branch could never even be
  // reached -- every client looked like case 1 above and got clobbered.
  {
    const clients = [{ id: 'c3', uuid: 'u3', addr: '3 Elm St', city: 'X', zip: '00000', sqft: 2000, sqft_source: 'manual', sqft_from_records: null }];
    const { sandbox, state } = buildEnrichSandbox(clients, { '3 Elm St': { sqft: 3000 } });
    await sandbox.maidsEnrichMissingSqft();
    const u = state.updates.find(function (x) { return x.id === 'u3'; });
    check('manual sqft: the write payload does NOT include sqft at all', Object.prototype.hasOwnProperty.call(u.patch, 'sqft'), false);
    check('manual sqft: still records sqft_from_records for comparison', u.patch.sqft_from_records, 3000);
  }

  // A failed lookup (no address match) still flags for manual review, unchanged behavior.
  {
    const clients = [{ id: 'c4', uuid: 'u4', addr: '4 Nowhere Rd', city: 'X', zip: '00000', sqft: null, sqft_source: 'unknown', sqft_from_records: null }];
    const { sandbox, state } = buildEnrichSandbox(clients, { '4 Nowhere Rd': null });
    await sandbox.maidsEnrichMissingSqft();
    const u = state.updates.find(function (x) { return x.id === 'u4'; });
    check('failed lookup adds the needs_address_details review flag, does not touch sqft', u.patch.review_flags, ['needs_address_details']);
  }

  // Candidate filter: a client whose sqft_from_records is ALREADY populated
  // (already looked up in a prior run) must not be re-queried.
  {
    const clients = [{ id: 'c5', uuid: 'u5', addr: '5 Pine St', city: 'X', zip: '00000', sqft: 2000, sqft_source: 'manual', sqft_from_records: 2050 }];
    const { sandbox, state } = buildEnrichSandbox(clients, { '5 Pine St': { sqft: 9999 } });
    await sandbox.maidsEnrichMissingSqft();
    check('a client with sqft_from_records already set is skipped entirely (not re-looked-up)', state.updates.length, 0);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
