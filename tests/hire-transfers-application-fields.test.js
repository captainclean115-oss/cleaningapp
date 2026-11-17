// Hire-transfer-missing-fields fix — hireApplicant() used to build its
// employee insert row from a hardcoded 9-field list, silently dropping
// every other field an applicant actually filled in (address included).
// This file drives the REAL hireApplicant() + PentaEmployees facade
// (extracted from index.html and run in a vm sandbox against a fake
// Supabase client) with FAKE applicant data only — never real names,
// addresses, or any other personal data, per this fix's own privacy rule.
//
// Also covers backfill-hire-transfer-fields.js's own "only fill empty
// fields, never overwrite, idempotent on re-run" logic, since that script
// is the mechanism used to catch up employees hired before this fix.
//
// Run with: node tests/hire-transfers-application-fields.test.js

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
  return src.slice(startIdx, endIdx);
}

const pentaEmployeesSrc = extract(
  '// window.PentaEmployees — Sprint 4 Phase 4A facade',
  '\n})();\n'
) + '\n})();\n';

const hireApplicantSrc = extract(
  'async function hireApplicant(id) {',
  '\nfunction openManagerApplication()'
);

// A fake applicant with EVERY field the application form collects filled
// in with obviously-fake placeholder data (never real applicant data).
function fakeFullApplication(overrides) {
  return Object.assign({
    id: 'app-fake-1',
    business_id: 'biz-fake-1',
    first_name: 'Testy',
    last_name: 'McTestface',
    phone: '555-123-4567',
    email: 'testy.mctestface@example.invalid',
    address: '1 Fake Street',
    city: 'Faketown',
    state: 'FS',
    zip_code: '00000',
    work_authorization: 'yes',
    drivers_license_status: 'yes',
    available_days: 'mon,wed,fri',
    prior_cleaning_experience: '2 years',
    hours_per_week_desired: 'morning',
    emergency_contact_name: 'Fakey Contact',
    emergency_contact_phone: '555-987-6543',
    emergency_contact_relation: 'sibling',
    preferred_language: 'es',
    has_reliable_transportation: true,
    prior_employer: 'Fake Cleaning Co',
    earliest_start_date: '2026-12-01'
  }, overrides || {});
}

function buildFakeSupabase(state) {
  return {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'manager-fake-1' } } } }); },
      getUser: function () { return Promise.resolve({ data: { user: { id: 'manager-fake-1' } } }); }
    },
    from: function (table) {
      if (table === 'job_applications') {
        return {
          select: function () {
            return { eq: function () { return { single: function () { return Promise.resolve({ data: state.app, error: state.app ? null : new Error('not found') }); } }; } };
          },
          update: function (patch) {
            state.appUpdatePatch = patch;
            return { eq: function () { return Promise.resolve({ data: null, error: null }); } };
          }
        };
      }
      if (table === 'employees') {
        return {
          select: function () {
            return {
              eq: function () {
                return {
                  eq: function () {
                    return { maybeSingle: function () { return Promise.resolve({ data: state.conflictingEmployee || null, error: null }); } };
                  }
                };
              }
            };
          },
          insert: function (row) {
            state.insertedRow = row;
            return { select: function () { return { maybeSingle: function () { return Promise.resolve({ data: Object.assign({ id: 'emp-fake-1' }, row), error: null }); } }; } };
          },
          update: function (patch) {
            state.updatePatches = state.updatePatches || [];
            state.updatePatches.push(patch);
            return {
              eq: function () {
                return {
                  select: function () {
                    return {
                      maybeSingle: function () {
                        if (state.followUpUpdateError) return Promise.resolve({ data: null, error: state.followUpUpdateError });
                        return Promise.resolve({ data: Object.assign({ id: 'emp-fake-1' }, patch), error: null });
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'users') {
        // PentaEmployees._businessId()'s fallback lookup; not under test here.
        return {
          select: function () {
            return {
              eq: function () {
                return { maybeSingle: function () { return Promise.resolve({ data: null, error: null }); } };
              }
            };
          }
        };
      }
      throw new Error('unexpected table: ' + table);
    }
  };
}

function buildSandbox(state) {
  const sandbox = {
    console,
    window: {},
    document: { getElementById: function () { return null; } },
    confirm: function () { return true; },
    alert: function (msg) { (sandbox.alerts = sandbox.alerts || []).push(msg); },
    closeApplicantDetail: function () {},
    renderApplicantsList: function () {}
  };
  const fakeSb = buildFakeSupabase(state);
  sandbox.window.supabaseClient = fakeSb;
  sandbox.window.PentaAuth = { client: fakeSb };
  vm.createContext(sandbox);
  vm.runInContext(pentaEmployeesSrc, sandbox);
  vm.runInContext(hireApplicantSrc, sandbox);
  return sandbox;
}

async function main() {
  // ---- A fake application with every field filled converts into an
  // employee insert row with every mapped field present. ----
  {
    const state = { app: fakeFullApplication() };
    const sandbox = buildSandbox(state);
    await sandbox.hireApplicant('app-fake-1');

    const row = state.insertedRow;
    check('insert was called at all', !!row, true);
    check('first_name carried over', row.first_name, 'Testy');
    check('last_name carried over', row.last_name, 'McTestface');
    check('address carried over', row.address, '1 Fake Street');
    check('city carried over', row.city, 'Faketown');
    check('state carried over', row.state, 'FS');
    check('zip carried over (from application\'s zip_code)', row.zip, '00000');
    check('work_auth carried over (from application\'s work_authorization)', row.work_auth, 'yes');
    check('has_license carried over (from application\'s drivers_license_status)', row.has_license, 'yes');
    check('available_days split into an array', row.available_days, ['mon', 'wed', 'fri']);
    check('experience carried over (from application\'s prior_cleaning_experience)', row.experience, '2 years');
    check('preferred_start_time carried over (semantic remap from hours_per_week_desired)', row.preferred_start_time, 'morning');
    check('emergency_contact_name carried over', row.emergency_contact_name, 'Fakey Contact');
    check('emergency_contact_phone carried over', row.emergency_contact_phone, '555-987-6543');
    check('emergency_contact_relationship carried over (from application\'s emergency_contact_relation)', row.emergency_contact_relationship, 'sibling');
    check('preferred_language carried over', row.preferred_language, 'es');

    // The 3 migration-124 fields go through a SEPARATE, best-effort
    // follow-up update() call -- not the main insert row.
    check('a follow-up update call was made for the migration-124 fields', (state.updatePatches || []).length, 1);
    const followUp = state.updatePatches[0];
    check('has_reliable_transportation carried over via the follow-up patch', followUp.has_reliable_transportation, true);
    check('prior_employer carried over via the follow-up patch', followUp.prior_employer, 'Fake Cleaning Co');
    check('earliest_start_date carried over via the follow-up patch', followUp.earliest_start_date, '2026-12-01');
  }

  // ---- Fields the applicant left blank map to null, never crash, and
  // never block the hire. ----
  {
    const state = {
      app: fakeFullApplication({
        address: '', city: '', state: '', zip_code: '',
        emergency_contact_name: '', emergency_contact_phone: '', emergency_contact_relation: '',
        has_reliable_transportation: null, prior_employer: '', earliest_start_date: ''
      })
    };
    const sandbox = buildSandbox(state);
    await sandbox.hireApplicant('app-fake-1');
    check('hire still succeeds with blank optional fields', !!state.insertedRow, true);
    // _toRow omits a field entirely when it's null/blank on a fresh insert
    // (the column then just gets its own DB default of NULL) -- not an
    // empty string, and no crash either way.
    check('a blank address is never sent as an empty string', state.insertedRow.address, undefined);
    check('a blank emergency contact name is never sent as an empty string', state.insertedRow.emergency_contact_name, undefined);
  }

  // ---- The migration-124 follow-up patch failing (e.g. migration not
  // applied yet on this environment) never blocks or undoes the hire
  // itself -- it is a separate, non-blocking call. ----
  {
    const state = {
      app: fakeFullApplication(),
      followUpUpdateError: new Error('column "has_reliable_transportation" does not exist')
    };
    const sandbox = buildSandbox(state);
    await sandbox.hireApplicant('app-fake-1');
    check('the main hire (insert) still succeeded despite the follow-up patch failing', !!state.insertedRow, true);
    check('the application was still marked hired', !!state.appUpdatePatch && state.appUpdatePatch.status === 'hired', true);
  }

  // ---- Re-hiring the same applicant (duplicate email) never creates a
  // second employee row. ----
  {
    const state = {
      app: fakeFullApplication(),
      conflictingEmployee: { id: 'emp-existing-1', first_name: 'Testy', last_name: 'McTestface' }
    };
    const sandbox = buildSandbox(state);
    await sandbox.hireApplicant('app-fake-1');
    check('no insert happens when an employee with that email already exists', state.insertedRow, undefined);
    check('an alert explains the duplicate instead of silently failing', (sandbox.alerts || []).some(function (m) { return /already exists/.test(m); }), true);
  }

  // ---- backfill-hire-transfer-fields.js: only ever fills a currently-
  // empty employee field, never overwrites one that's already set, and
  // re-running it after it already filled something is a no-op. ----
  {
    const backfillSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'backfill-hire-transfer-fields.js'), 'utf8');

    function buildBackfillSandbox(appRow, empRow) {
      const state = { empRow: Object.assign({ id: 'emp-fake-2' }, empRow), updateCalls: [] };
      const fakeSb = {
        from: function (table) {
          if (table === 'job_applications') {
            return {
              select: function () {
                return {
                  eq: function () {
                    return { not: function () { return Promise.resolve({ data: [appRow], error: null }); } };
                  }
                };
              }
            };
          }
          if (table === 'employees') {
            return {
              select: function () {
                return {
                  eq: function () {
                    return { maybeSingle: function () { return Promise.resolve({ data: state.empRow, error: null }); } };
                  }
                };
              }
            };
          }
          throw new Error('unexpected table: ' + table);
        }
      };
      const sandbox = {
        console,
        window: {
          supabaseClient: fakeSb,
          PentaEmployees: {
            update: function (id, patch) {
              state.updateCalls.push(patch);
              Object.assign(state.empRow, patch);
              return Promise.resolve(Object.assign({}, state.empRow));
            }
          }
        }
      };
      vm.createContext(sandbox);
      vm.runInContext(backfillSrc, sandbox);
      return { sandbox: sandbox, state: state };
    }

    const fakeApp = {
      hired_employee_id: 'emp-fake-2',
      first_name: 'Fakey', last_name: 'Fakerson',
      address: '2 Fake Ave', city: 'Faketown', state: null, zip_code: null,
      work_authorization: null, drivers_license_status: null, available_days: null,
      prior_cleaning_experience: 'already here on the app too',
      hours_per_week_desired: null,
      emergency_contact_name: null, emergency_contact_phone: null, emergency_contact_relation: null,
      preferred_language: null, has_reliable_transportation: null, prior_employer: null, earliest_start_date: null
    };
    const fakeEmpMissingAddress = { first_name: 'Fakey', last_name: 'Fakerson', address: null, city: null, experience: 'manager already typed this in' };

    // Dry run reports the gap but writes nothing.
    {
      const { sandbox, state } = buildBackfillSandbox(fakeApp, fakeEmpMissingAddress);
      await sandbox.window._backfillHireFields({});
      check('dry run makes no update() calls', state.updateCalls.length, 0);
    }

    // Applying fills ONLY the empty fields -- never the one the manager
    // already typed (experience), even though the application also has
    // a value for it.
    {
      const { sandbox, state } = buildBackfillSandbox(fakeApp, fakeEmpMissingAddress);
      await sandbox.window._backfillHireFields({ apply: true });
      check('exactly one update() call is made', state.updateCalls.length, 1);
      check('the empty address field gets filled', state.updateCalls[0].address, '2 Fake Ave');
      check('the already-set experience field is never included in the patch', Object.prototype.hasOwnProperty.call(state.updateCalls[0], 'experience'), false);
      check('the manager-typed experience value survives untouched on the employee row', state.empRow.experience, 'manager already typed this in');

      // Re-running after the first apply is a no-op: nothing left to fill,
      // so no further update() calls -- confirms re-running never
      // duplicates or re-writes anything.
      await sandbox.window._backfillHireFields({ apply: true });
      check('re-running after everything is already filled makes no additional update() calls', state.updateCalls.length, 1);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
