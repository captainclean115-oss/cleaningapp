// Architecture question from Tom: "why do manual hour overrides go to
// localStorage at all?" saveEmpDayHours's Save button was writing
// corrections (empHrs_{empId}_{date}) purely to localStorage, hitting
// quota limits -- and confirmed via full-file read, there was NEVER a
// Supabase write anywhere in that path. These are authoritative payroll
// corrections, not a device cache: being localStorage-only meant they
// were invisible on any other browser/device (a manager's own phone vs.
// desktop, the employee's own portal login), permanently lost if
// localStorage was ever cleared, and the "quota limits" symptom was a
// direct consequence of piling business data into browser storage never
// meant to hold it.
//
// Fix: migration 110 adds manual_hour_overrides (one row per business/
// employee/date, RLS-scoped, modeled on lunch_flag_overrides). A new
// PentaHourOverrides module (mirrors PentaLunchFlags' hydrate/cache/
// notify shape) replaces the localStorage read/write in
// getEmpHours/saveEmpHours/clearEmpHours. Every render call site keeps
// working unchanged (reads stay synchronous, off an in-memory cache
// hydrated fresh from Supabase every session/device); every write call
// site (saveEmpDayHours, clearEmpDayHours, Claire's edit_employee_hours
// tool) now awaits the write and surfaces a real failure instead of
// silently succeeding.
//
// Run with: node tests/manual-hour-overrides-supabase.test.js

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

function extract(startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) { console.error('FAIL: could not find end marker after ' + startMarker); process.exit(1); }
  return src.slice(startIdx, endIdx + endMarker.length);
}

const pentaHourOverridesSrc = extract(
  'window.PentaHourOverrides = (function() {',
  '\n})();'
);

// ---- Build a fake Supabase client good enough to drive setOverride/
// clearOverride/hydrate through the same .from().select()/.upsert()/
// .delete() chain the real module uses. ----
function buildFakeSupabase(state) {
  return {
    auth: { getUser: function () { return Promise.resolve({ data: { user: { id: 'fallback-user' } } }); } },
    from: function (table) {
      check.calledTable = table;
      return {
        select: function () {
          return {
            eq: function () {
              return Promise.resolve({ data: state.rows.slice(), error: state.hydrateError || null });
            }
          };
        },
        upsert: function (row) {
          return {
            select: function () {
              return {
                single: function () {
                  if (state.upsertError) return Promise.resolve({ data: null, error: state.upsertError });
                  var existing = state.rows.find(function (r) { return r.employee_id === row.employee_id && r.date === row.date; });
                  var saved = Object.assign({ id: (existing && existing.id) || 'row-' + (state.rows.length + 1) }, row);
                  if (existing) Object.assign(existing, saved); else state.rows.push(saved);
                  state.lastUpsert = row;
                  return Promise.resolve({ data: saved, error: null });
                }
              };
            }
          };
        },
        delete: function () {
          var filters = {};
          var chain = {
            eq: function (col, val) { filters[col] = val; return chain; },
            then: function (resolve) {
              if (state.deleteError) { resolve({ error: state.deleteError }); return; }
              state.rows = state.rows.filter(function (r) {
                return !(r.business_id === filters.business_id && r.employee_id === filters.employee_id && r.date === filters.date);
              });
              state.lastDelete = filters;
              resolve({ error: null });
            }
          };
          return chain;
        }
      };
    }
  };
}

function buildSandbox(state, opts) {
  opts = opts || {};
  const sandbox = {
    console,
    window: {},
  };
  sandbox.window.supabaseClient = buildFakeSupabase(state);
  sandbox.window.PentaTenant = { current: function () { return opts.noBusinessId ? null : 'biz-1'; } };
  sandbox.window.PentaAuth = { session: { user: { id: 'actor-1' } } };
  var EMP_UUID = '986fae58-3d55-44d3-a826-a05ae7e873cb';
  sandbox.EMP_UUID = EMP_UUID;
  sandbox.window.PentaEmployees = {
    getByLegacyRosterId: function (id) {
      if (id === 'e_legacy_1') return { id: EMP_UUID, name: 'Etelvina Cabral' };
      return null;
    }
  };
  sandbox.window.PentaAssignments = {
    resolveEmployeeId: function (id) {
      if (id === 'e_legacy_1') return Promise.resolve(EMP_UUID);
      return Promise.resolve(null);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(pentaHourOverridesSrc, sandbox);
  return sandbox;
}

async function main() {
  // ---- setOverride resolves a legacy_roster_id to the real uuid before
  // writing, and stamps created_by/updated_by from the actor. ----
  {
    const state = { rows: [] };
    const sandbox = buildSandbox(state);
    await sandbox.window.PentaHourOverrides.ready();
    const saved = await sandbox.window.PentaHourOverrides.setOverride('e_legacy_1', '2026-08-31', { start: '09:00', end: '17:00', lunch: 30, hours: 7.5, team: 'B3' });
    check('the write targets the real employees uuid, not the legacy id', saved.employee_id, '986fae58-3d55-44d3-a826-a05ae7e873cb');
    check('business_id is stamped from PentaTenant', saved.business_id, 'biz-1');
    check('created_by/updated_by are stamped from the current session', saved.created_by === 'actor-1' && saved.updated_by === 'actor-1', true);
  }

  // ---- getOverride is a SYNCHRONOUS read off the already-hydrated
  // cache, returning the same shape the old localStorage getEmpHours()
  // did -- so render call sites (renderHoursTable, showEmpDayDetail,
  // the portal) work unchanged. ----
  {
    const state = { rows: [{ id: 'r1', business_id: 'biz-1', employee_id: '986fae58-3d55-44d3-a826-a05ae7e873cb', date: '2026-08-31', start_time: '09:00', end_time: '17:00', lunch_minutes: 30, hours: 7.5, team: 'B3' }] };
    const sandbox = buildSandbox(state);
    await sandbox.window.PentaHourOverrides.ready();
    const got = sandbox.window.PentaHourOverrides.getOverride('e_legacy_1', '2026-08-31');
    check('getOverride resolves the legacy id and returns the override', got, { start: '09:00', end: '17:00', lunch: 30, hours: 7.5, team: 'B3' });
    const gotUuid = sandbox.window.PentaHourOverrides.getOverride('986fae58-3d55-44d3-a826-a05ae7e873cb', '2026-08-31');
    check('getOverride also accepts the uuid directly', gotUuid, { start: '09:00', end: '17:00', lunch: 30, hours: 7.5, team: 'B3' });
    const gotMiss = sandbox.window.PentaHourOverrides.getOverride('e_legacy_1', '2026-09-01');
    check('getOverride returns null for a date with no override', gotMiss, null);
  }

  // ---- clearOverride deletes the real row and updates the cache so a
  // subsequent getOverride sees it gone immediately. ----
  {
    const state = { rows: [{ id: 'r1', business_id: 'biz-1', employee_id: '986fae58-3d55-44d3-a826-a05ae7e873cb', date: '2026-08-31', start_time: '09:00', end_time: '17:00', lunch_minutes: 30, hours: 7.5, team: 'B3' }] };
    const sandbox = buildSandbox(state);
    await sandbox.window.PentaHourOverrides.ready();
    await sandbox.window.PentaHourOverrides.clearOverride('e_legacy_1', '2026-08-31');
    check('the row is gone from the fake server state', state.rows.length, 0);
    check('getOverride reflects the clear immediately (no re-hydrate needed)', sandbox.window.PentaHourOverrides.getOverride('e_legacy_1', '2026-08-31'), null);
  }

  // ---- setOverride surfaces a real failure instead of pretending it
  // saved -- this is what saveEmpDayHours/Claire's tool now depend on to
  // report an accurate error instead of silently losing the correction. ----
  {
    const state = { rows: [], upsertError: { message: 'permission denied for table manual_hour_overrides' } };
    const sandbox = buildSandbox(state);
    await sandbox.window.PentaHourOverrides.ready();
    let threw = null;
    try { await sandbox.window.PentaHourOverrides.setOverride('e_legacy_1', '2026-08-31', { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 }); }
    catch (e) { threw = e; }
    check('a real Supabase error propagates instead of being swallowed', !!threw, true);
    check('the cache is NOT updated when the write fails', sandbox.window.PentaHourOverrides.getOverride('e_legacy_1', '2026-08-31'), null);
  }

  // ---- an employee id that can't be resolved at all (deleted employee,
  // bad data) fails loudly on write instead of silently writing under a
  // key nothing will ever read again (the PR #134 bug this whole file's
  // convention exists to prevent). ----
  {
    const state = { rows: [] };
    const sandbox = buildSandbox(state);
    await sandbox.window.PentaHourOverrides.ready();
    let threw = null;
    try { await sandbox.window.PentaHourOverrides.setOverride('e_unknown', '2026-08-31', { start: '09:00', end: '17:00' }); }
    catch (e) { threw = e; }
    check('an unresolvable employee id throws instead of writing under a dead key', !!threw, true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
