// Root cause behind "still showing no schedule for tomorrow" surviving
// two prior fixes (PR #160, #161): window.PentaEmployees.getById never
// existed. The facade only ever exported get() (async, awaits hydrate),
// getByLegacyRosterId(), getByAuthUserId(), getByName(), find(), filter()
// -- never a sync getById(uuid). Five call sites across the file called
// window.PentaEmployees.getById(...) anyway, always getting undefined:
//
//   - _mirrorPentaAssignmentsToInMemory's `hasFacade` guard (index.html) --
//     always false, so the dailyAssignments dual-key mirror NEVER wrote
//     the legacy_roster_id-keyed entries it exists specifically to write.
//     The employee portal's getEmployeeTeam(currentEmployee.id, date) --
//     currentEmployee.id being legacy_roster_id-preferred -- could never
//     find a day-specific override there, no matter how correct the
//     read-side logic (PR #160) or the re-render timing (PR #161) were.
//   - _computeFormImpact (Sprint 9 Impact Rules Engine): always resolved
//     `emp` to null, so EVERY callout/timeoff form got severity 'green'
//     with reason 'Employee not found in roster', regardless of the real
//     employee or real schedule impact -- silently broken since it shipped.
//   - buildClaireContext's employee-id resolution: ctx.employees was
//     always empty, same story.
//
// This test proves the missing method is now real and does a synchronous
// cache lookup, mirroring PentaTeams.getById()'s contract (and the sibling
// getByLegacyRosterId/getByAuthUserId/getByName sync-scan pattern already
// used elsewhere in this same facade) -- not a re-mock of the dependency,
// but extraction of the ACTUAL PentaEmployees IIFE so a future accidental
// removal/rename would be caught here instead of only failing silently
// downstream again.
//
// Run with: node tests/penta-employees-getbyid.test.js

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

// Extract the real PentaEmployees IIFE and run it in a sandbox with a
// stubbed Supabase client so _hydrate() can seed _cache synchronously
// via a resolved promise chain.
const START_ANCHOR = '// window.PentaEmployees — Sprint 4 Phase 4A facade';
const anchorIdx = src.indexOf(START_ANCHOR);
if (anchorIdx === -1) { console.error('FAIL: could not find the PentaEmployees facade comment anchor'); process.exit(1); }
const startIdx = src.indexOf('(function() {', anchorIdx);
if (startIdx === -1) { console.error('FAIL: could not find PentaEmployees IIFE start after the anchor comment'); process.exit(1); }
const END = 'window.PentaForms = (function() {';
const endMarkerIdx = src.indexOf(END, startIdx);
if (endMarkerIdx === -1) { console.error('FAIL: could not find PentaForms boundary after PentaEmployees'); process.exit(1); }
// The IIFE itself ends with "})();" just before the PentaForms section --
// walk back from endMarkerIdx to the last "})();" before it.
const endIdx = src.lastIndexOf('})();', endMarkerIdx);
if (endIdx === -1 || endIdx < startIdx) { console.error('FAIL: could not find PentaEmployees IIFE end boundary'); process.exit(1); }
const iifeSource = src.slice(startIdx, endIdx + '})();'.length);

async function main() {
  const rows = [
    { id: '7a8465c8-8ae1-48f8-8657-bfe407f21091', legacy_roster_id: 'app_796a8946', first_name: 'Melissa', last_name: 'Manna', business_id: 'biz-1', status: 'active' },
    { id: '11111111-1111-1111-1111-111111111111', legacy_roster_id: 'e_42', first_name: 'Old', last_name: 'Timer', business_id: 'biz-1', status: 'active' },
  ];
  const sandbox = {
    console,
    window: {},
    supabaseClient: {
      auth: { getUser: function() { return Promise.resolve({ data: { user: { id: 'auth-1' } } }); } },
      from: function(table) {
        if (table === 'users') {
          return {
            select: function() { return this; },
            eq: function() { return this; },
            maybeSingle: function() { return Promise.resolve({ data: { business_id: 'biz-1' }, error: null }); },
          };
        }
        if (table !== 'employees') throw new Error('unexpected table ' + table);
        return {
          select: function() { return this; },
          eq: function() { return this; },
          is: function() { return this; },
          order: function() { return Promise.resolve({ data: rows, error: null }); },
        };
      },
    },
  };
  sandbox.window.supabaseClient = sandbox.supabaseClient;
  vm.createContext(sandbox);
  vm.runInContext(iifeSource, sandbox);

  check('window.PentaEmployees.getById is exported as a function (was undefined before this fix)', typeof sandbox.window.PentaEmployees.getById, 'function');

  await sandbox.window.PentaEmployees._hydrate();

  check(
    'getById resolves an app-hired employee by their real uuid (the exact case that broke the assignments mirror)',
    sandbox.window.PentaEmployees.getById('7a8465c8-8ae1-48f8-8657-bfe407f21091') && sandbox.window.PentaEmployees.getById('7a8465c8-8ae1-48f8-8657-bfe407f21091').legacy_roster_id,
    'app_796a8946'
  );
  check(
    'getById resolves a roster-import employee too',
    sandbox.window.PentaEmployees.getById('11111111-1111-1111-1111-111111111111') && sandbox.window.PentaEmployees.getById('11111111-1111-1111-1111-111111111111').legacy_roster_id,
    'e_42'
  );
  check('getById returns null for an unknown id, not throw', sandbox.window.PentaEmployees.getById('does-not-exist'), null);
  check('getById returns null for a missing/undefined id, not throw', sandbox.window.PentaEmployees.getById(undefined), null);
  check(
    'getById is synchronous -- does not require an await (the mirror\'s for-loop calls it without one)',
    sandbox.window.PentaEmployees.getById('7a8465c8-8ae1-48f8-8657-bfe407f21091') instanceof Promise,
    false
  );

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function(e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
