// Tom: "i am hitting not lunch on things and it shows i removed it at
// first but after page refresh its back, is not saving." The write was
// never the problem -- confirmed live via Supabase that every override he
// set was landing correctly in lunch_flag_overrides. The read side was
// broken: PentaLunchFlags's own IIFE calls _hydrate() synchronously at
// script-parse time, which races the auth session restoring
// (_businessId() depends on PentaTenant.current(), populated
// asynchronously). On a fresh reload this first automatic call can
// genuinely fire before business_id is available -- every OTHER facade in
// this file (PentaEmployees, PentaAssignments) resets `_hydrating = null`
// on that exact bail so a later ready() call retries once tenant/auth
// catches up. PentaLunchFlags didn't: `_hydrating` stayed a permanently-
// resolved promise, `_ready` got set true with an empty cache, and NO
// later `await PentaLunchFlags.ready()` call (loadGPSData has one) ever
// re-fetched -- an override that saved correctly server-side looked
// permanently reverted on every fresh page load.
//
// Run with: node tests/lunch-flags-hydrate-retry.test.js

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

const startMarker = 'window.PentaLunchFlags = (function() {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find PentaLunchFlags IIFE'); process.exit(1); }
const endMarker = '\n})();\n';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) { console.error('FAIL: could not find PentaLunchFlags end boundary'); process.exit(1); }
const iifeSource = src.slice(startIdx, endIdx + endMarker.length);

function buildSandbox() {
  // Starts with NO tenant available -- reproduces the real boot race:
  // the module's own `_hydrate()` call (fired synchronously as the IIFE
  // runs) sees no business_id yet, exactly like a fresh page load where
  // auth/tenant hasn't finished restoring when this script parses.
  const state = { tenantReady: false, queryCount: 0 };
  const rows = [{ id: 'row-1', team: 'B1', date: '2026-08-26', stop_key: '2026-08-26T16:19:40.000Z', override_type: 'exclude', stop_address: '664 Washington St, Quincy', stop_duration_min: 6, created_at: '2026-09-04T00:39:28Z' }];
  const sandbox = {
    console,
    window: {
      PentaTenant: { current: function () { return state.tenantReady ? 'biz-1' : null; } },
      supabaseClient: {
        from: function (table) {
          if (table !== 'lunch_flag_overrides') throw new Error('unexpected table ' + table);
          return {
            select: function () { return this; },
            eq: function () {
              state.queryCount++;
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      },
    },
  };
  sandbox.supabaseClient = sandbox.window.supabaseClient;
  vm.createContext(sandbox);
  vm.runInContext(iifeSource, sandbox);
  return { sandbox, state };
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

async function main() {
  const { sandbox, state } = buildSandbox();

  // The module's own automatic _hydrate() call already ran synchronously
  // during the IIFE above, hitting the race (no tenant yet) -- confirm it
  // bailed without fetching anything. Let the failed attempt's own
  // .then() reset actually run (a real microtask tick) before checking --
  // in production there's a long real gap here (auth/tenant restoring,
  // other renders) before any caller awaits ready() again; a bare
  // synchronous check right after sandbox setup would race the reset
  // itself, same class of timing trap the production fix had to account
  // for (see the fix's own comment on why the reset lives in a .then()).
  await tick();
  check('immediately after load (tenant not ready yet), cache is empty -- the race really did happen', sandbox.window.PentaLunchFlags.listForTeamDate('B1', '2026-08-26'), []);
  check('no query was made yet (bailed before hitting the DB)', state.queryCount, 0);

  // Tenant becomes available shortly after (the real, normal sequence --
  // auth/tenant restoration finishes a beat after this module's own
  // script executes). A later caller (loadGPSData does this before every
  // render) awaits ready() again.
  state.tenantReady = true;
  await sandbox.window.PentaLunchFlags.ready();

  check('after tenant becomes available and ready() is awaited again, the retry actually queries this time', state.queryCount, 1);
  check(
    'the real override now shows up -- this is what was missing after every fresh reload',
    sandbox.window.PentaLunchFlags.getOverride('B1', '2026-08-26', '2026-08-26T16:19:40.000Z'),
    { id: 'row-1', team: 'B1', date: '2026-08-26', stop_key: '2026-08-26T16:19:40.000Z', override_type: 'exclude', stop_address: '664 Washington St, Quincy', stop_duration_min: 6, created_at: '2026-09-04T00:39:28Z' }
  );

  // A THIRD ready() call must not re-query -- once genuinely hydrated,
  // it should behave like every other facade's cache (fetch once, reuse).
  await sandbox.window.PentaLunchFlags.ready();
  check('a subsequent ready() call after a successful hydrate does not re-query needlessly', state.queryCount, 1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
