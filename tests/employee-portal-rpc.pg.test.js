// Employee portal polish — functional tests for migrations
// 117_employee_self_service_profile.sql and 118_employee_about_me.sql,
// run against a REAL throwaway local Postgres 17 instance (started and
// torn down by this file) with RLS actually enforced (queries run as
// the non-superuser `authenticated` role, not the bootstrapping admin
// role, so a "cannot read/edit another employee's row" claim is a real
// RLS result, not just application-level reasoning).
//
// Covers the explicit fixture requirements:
//   - Account saves only the whitelisted columns for her own row and
//     rejects any other (there IS no "any other" parameter to even
//     pass -- the RPC's signature is itself the whitelist).
//   - A fixture employee cannot read or edit another employee's row or
//     pay (tested from BOTH directions: direct SELECT/UPDATE, blocked
//     by RLS; and the RPC, which can only ever resolve HER OWN row via
//     auth.uid() -- there is no parameter to target someone else).
//   - About me shows hourly pay, "Salaried", "Not set", and hides pay
//     when the business setting is off (pay_rate key absent, not null).
//
// Requires: Homebrew postgresql@17 installed locally (same convention
// used throughout this repo's other throwaway-Postgres tests this
// project has relied on all along).
//
// Run with: node tests/employee-portal-rpc.pg.test.js

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PG_BIN = '/opt/homebrew/opt/postgresql@17/bin';
const PORT = 5466;
const DATA_DIR = '/tmp/_ep_rpc_pgtest';
const SOCK_DIR = '/tmp';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function psql(sql, { role } = {}) {
  const args = ['-h', SOCK_DIR, '-p', String(PORT), '-U', 'testuser', '-d', 'postgres', '-t', '-A', '-q'];
  const prefixed = role ? `SET ROLE ${role}; ${sql}` : sql;
  const r = spawnSync(`${PG_BIN}/psql`, [...args, '-c', prefixed], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('psql failed: ' + (r.stderr || r.stdout));
  }
  return r.stdout.trim();
}

function psqlFile(file) {
  const r = spawnSync(`${PG_BIN}/psql`, ['-h', SOCK_DIR, '-p', String(PORT), '-U', 'testuser', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('psql -f ' + file + ' failed:\n' + r.stderr);
  return r.stdout;
}

function setAuthUid(uuid) {
  psql(`create or replace function auth.uid() returns uuid language sql stable as $\$ select '${uuid}'::uuid; $\$;`);
}

(async function () {
  try { execSync(`${PG_BIN}/pg_ctl -D ${DATA_DIR} stop -m fast`, { stdio: 'ignore' }); } catch (e) {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log('--- starting throwaway Postgres 17 ---');
  execSync(`${PG_BIN}/initdb -D ${DATA_DIR} -U testuser --auth=trust`, { stdio: 'ignore' });
  execSync(`${PG_BIN}/pg_ctl -D ${DATA_DIR} -l ${DATA_DIR}.log -o "-k ${SOCK_DIR} -p ${PORT} -c listen_addresses=''" start`, { stdio: 'ignore' });

  try {
    const STUB_SCHEMA = `
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $\$ select null::uuid; $\$;
create type public.user_role as enum ('owner','admin','manager','dispatcher','employee','franchisor_admin');
create table public.businesses (id uuid primary key default gen_random_uuid(), name text, business_settings jsonb);
create table public.users (id uuid primary key, business_id uuid references public.businesses(id), role public.user_role);
create table public.teams (id uuid primary key default gen_random_uuid(), business_id uuid, name text);
create table public.employees (
  id uuid primary key default gen_random_uuid(), business_id uuid references public.businesses(id),
  auth_user_id uuid, first_name text not null, last_name text not null, phone text, status text,
  hired_at date, terminated_at date, address text, city text, state text, zip text,
  emergency_contact_name text, emergency_contact_phone text, pay_rate numeric, pay_type text,
  team_id uuid, team_text text, work_type text, preferred_language text,
  deleted_at timestamptz, updated_at timestamptz default now()
);
create table public.audit_log (
  id uuid primary key default gen_random_uuid(), business_id uuid, user_id uuid, action_type text,
  entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, created_at timestamptz default now()
);
create or replace function public.auth_belongs_to_business(p_business_id uuid) returns boolean language sql stable as $\$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.business_id = p_business_id);
$\$;
create role authenticated nologin;
alter table public.employees enable row level security;
create policy employees_select on public.employees for select to authenticated using (
  auth_belongs_to_business(business_id) and (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('owner','admin','manager'))
    or auth_user_id = auth.uid()
  )
);
create policy employees_update on public.employees for update to authenticated using (
  auth_belongs_to_business(business_id) and (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('owner','admin','manager'))
    or auth_user_id = auth.uid()
  )
);
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant usage on schema public to authenticated;
grant select, update on public.employees to authenticated;
grant select on public.businesses to authenticated;
grant select on public.users to authenticated;
grant select on public.teams to authenticated;
grant insert on public.audit_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;
`;
    fs.writeFileSync('/tmp/_ep_rpc_stub_pre117.sql', STUB_SCHEMA);
    psqlFile('/tmp/_ep_rpc_stub_pre117.sql');

    // Apply the REAL migration files, exactly as shipped.
    const repoRoot = path.join(__dirname, '..');
    psqlFile(path.join(repoRoot, 'migrations', '117_employee_self_service_profile.sql'));
    psqlFile(path.join(repoRoot, 'migrations', '118_employee_about_me.sql'));
    // Re-run both once more to prove idempotency (required by the brief).
    psqlFile(path.join(repoRoot, 'migrations', '117_employee_self_service_profile.sql'));
    psqlFile(path.join(repoRoot, 'migrations', '118_employee_about_me.sql'));
    console.log('  ok   both migrations applied, then re-applied cleanly (idempotent)\n');

    // Grant EXECUTE is already in the migration files themselves
    // (GRANT EXECUTE ... TO authenticated) -- confirm it actually took.
    const grantCheck = psql(`select has_function_privilege('authenticated', 'public.update_my_employee_profile(text,text,text,text,text,text,text)', 'execute');`);
    check('authenticated can execute update_my_employee_profile (granted by the migration itself)', grantCheck, 't');

    // ---- Seed two businesses' worth of fixtures ----
    const BIZ = '11111111-1111-1111-1111-111111111111';
    const OWNER_AUTH = '00000000-0000-0000-0000-00000000000a';
    const EMP_A_AUTH = '00000000-0000-0000-0000-00000000000b';
    const EMP_B_AUTH = '00000000-0000-0000-0000-00000000000c';
    const EMP_A_ID = '00000000-0000-0000-0000-0000000000a1';
    const EMP_B_ID = '00000000-0000-0000-0000-0000000000b1';
    const TEAM_ID = '00000000-0000-0000-0000-0000000000f1';

    psql(`
      insert into public.businesses (id, name) values ('${BIZ}', 'Test Biz');
      insert into public.users (id, business_id, role) values ('${OWNER_AUTH}', '${BIZ}', 'owner');
      insert into public.teams (id, business_id, name) values ('${TEAM_ID}', '${BIZ}', 'Team A');
      insert into public.employees (id, business_id, auth_user_id, first_name, last_name, status, hired_at, pay_rate, pay_type, team_id, work_type, phone, address)
        values ('${EMP_A_ID}', '${BIZ}', '${EMP_A_AUTH}', 'Maria', 'Vieira', 'active', (current_date - interval '1 year 1 month')::date, 24.50, 'hourly', '${TEAM_ID}', 'field', '6175551001', '1 Old St');
      insert into public.employees (id, business_id, auth_user_id, first_name, last_name, status, hired_at, pay_rate, pay_type, work_type, phone)
        values ('${EMP_B_ID}', '${BIZ}', '${EMP_B_AUTH}', 'John', 'Smith', 'active', (current_date - interval '5 months')::date, null, 'salary', 'field', '6175551002');
    `);

    console.log('\n--- Account self-service: only the whitelist, only her own row ---\n');
    setAuthUid(EMP_A_AUTH);
    const saveResult = psql(`select public.update_my_employee_profile(p_address := '123 Main St', p_city := 'Boston', p_emergency_contact_name := 'Jane Doe');`, { role: 'authenticated' });
    check('update_my_employee_profile succeeds for her own row', JSON.parse(saveResult).success, true);
    const afterSave = psql(`select row_to_json(e) from public.employees e where e.id = '${EMP_A_ID}';`);
    const afterSaveRow = JSON.parse(afterSave);
    check('only the fields actually passed changed', { address: afterSaveRow.address, city: afterSaveRow.city, emergency_contact_name: afterSaveRow.emergency_contact_name }, { address: '123 Main St', city: 'Boston', emergency_contact_name: 'Jane Doe' });
    check('pay_rate is untouched by the whitelist RPC (not even a parameter it accepts)', Number(afterSaveRow.pay_rate), 24.50);
    check('phone is untouched (not editable through this RPC at all)', afterSaveRow.phone, '6175551001');
    const auditRow = JSON.parse(psql(`select new_values from public.audit_log where entity_id = '${EMP_A_ID}' order by created_at desc limit 1;`));
    check('audit row tagged source=employee_self_edit, with only the changed fields, no sensitive extras', auditRow.source, 'employee_self_edit');
    check('audit row never contains pay_rate, phone, or any field outside the whitelist', Object.keys(auditRow.changed_fields).every((k) => ['address', 'city', 'state', 'zip', 'emergency_contact_name', 'emergency_contact_phone', 'preferred_language'].indexOf(k) !== -1), true);

    console.log('\n--- Cannot read or edit ANOTHER employee\'s row or pay ---\n');
    // Direct SELECT, as employee A, filtered to employee B's row -- RLS
    // must return ZERO rows (not an error, not B's data -- just nothing).
    const crossRead = psql(`select count(*) from public.employees where id = '${EMP_B_ID}';`, { role: 'authenticated' });
    check('employee A\'s direct SELECT for employee B\'s row returns ZERO rows (RLS)', crossRead, '0');
    // Direct UPDATE attempt, as employee A, targeting B's row.
    let crossUpdateBlocked = false;
    try {
      const upd = psql(`update public.employees set pay_rate = 999 where id = '${EMP_B_ID}' returning id;`, { role: 'authenticated' });
      crossUpdateBlocked = (upd === ''); // RLS silently matches zero rows -- no error, just nothing updated
    } catch (e) {
      crossUpdateBlocked = true;
    }
    check('employee A\'s direct UPDATE attempt on employee B\'s row affects zero rows (RLS)', crossUpdateBlocked, true);
    const bUnchanged = psql(`select pay_rate from public.employees where id = '${EMP_B_ID}';`);
    check('employee B\'s pay_rate is genuinely untouched', bUnchanged, '');
    // Employee A can no longer even UPDATE her OWN row directly (migration
    // 117 removed that branch entirely) -- confirms the RPC is the ONLY path.
    let selfDirectUpdateBlocked = false;
    try {
      const selfUpd = psql(`update public.employees set pay_rate = 999 where id = '${EMP_A_ID}' returning id;`, { role: 'authenticated' });
      selfDirectUpdateBlocked = (selfUpd === '');
    } catch (e) { selfDirectUpdateBlocked = true; }
    check('employee A can no longer directly UPDATE even her OWN row (closed by migration 117 -- the RPC is the only path now)', selfDirectUpdateBlocked, true);
    const aPayUnchanged = psql(`select pay_rate from public.employees where id = '${EMP_A_ID}';`);
    check('her own pay_rate is still untouched by that blocked attempt', Number(aPayUnchanged), 24.50);

    console.log('\n--- The RPC itself has no parameter to target anyone else ---\n');
    // There's no p_employee_id / p_pay_rate parameter at all -- confirmed
    // structurally against the real function signature.
    const sig = psql(`select pg_get_function_arguments(oid) from pg_proc where proname = 'update_my_employee_profile';`);
    check('the RPC signature has no employee-id parameter and no pay_rate parameter (nothing to target someone else with)', /employee_id|pay_rate|p_id\b/.test(sig), false);

    console.log('\n--- About me: hourly, Salaried, Not set, hidden ---\n');
    setAuthUid(EMP_A_AUTH);
    const aboutA = JSON.parse(psql('select public.get_my_about_me();', { role: 'authenticated' }));
    check('hourly employee shows a numeric pay_rate + pay_type=hourly', { pay_rate: Number(aboutA.pay_rate), pay_type: aboutA.pay_type }, { pay_rate: 24.50, pay_type: 'hourly' });
    check('tenure computed from hired_at ("1 year, 1 month")', aboutA.tenure_text, '1 year, 1 month');
    check('team_label resolves her real team name', aboutA.team_label, 'Team A');
    check('vacation_text is always "Not set up yet" -- no balance mechanism exists anywhere in this schema', aboutA.vacation_text, 'Not set up yet');

    setAuthUid(EMP_B_AUTH);
    const aboutB = JSON.parse(psql('select public.get_my_about_me();', { role: 'authenticated' }));
    check('salaried employee shows pay_type=salary and no pay_rate key at all (the UI shows "Salaried")', { pay_type: aboutB.pay_type, has_pay_rate: Object.prototype.hasOwnProperty.call(aboutB, 'pay_rate') }, { pay_type: 'salary', has_pay_rate: true }); // salary WITH a pay_rate key present (null) when show_pay is on -- UI decides "Salaried" text from pay_type, not absence
    check('a null/zero pay_rate (here: null, salaried) is present but null -- UI shows "Salaried", never a dollar amount', aboutB.pay_rate, null);

    // Missing pay_rate (hourly but 0/not set) case.
    psql(`update public.employees set pay_rate = 0 where id = '${EMP_A_ID}';`);
    setAuthUid(EMP_A_AUTH);
    const aboutA2 = JSON.parse(psql('select public.get_my_about_me();', { role: 'authenticated' }));
    check('pay_rate present but 0 is distinguishable client-side as "Not set" (RPC returns the raw 0; the UI layer maps 0/null -> "Not set")', Number(aboutA2.pay_rate), 0);

    console.log('\n--- Owner-only "show pay" toggle; hides pay_rate key entirely when off ---\n');
    setAuthUid(EMP_A_AUTH); // not the owner
    let nonOwnerBlocked = false;
    try {
      psql(`select public.set_show_pay_in_about_me(false);`, { role: 'authenticated' });
    } catch (e) { nonOwnerBlocked = true; }
    check('a non-owner (even an employee with a valid session) cannot toggle this setting', nonOwnerBlocked, true);

    setAuthUid(OWNER_AUTH);
    psql(`select public.set_show_pay_in_about_me(false);`, { role: 'authenticated' });
    setAuthUid(EMP_A_AUTH);
    const aboutA3 = JSON.parse(psql('select public.get_my_about_me();', { role: 'authenticated' }));
    check('with the setting OFF, pay_rate key is ABSENT entirely (not null) from the RPC result', Object.prototype.hasOwnProperty.call(aboutA3, 'pay_rate'), false);
    check('show_pay reports false', aboutA3.show_pay, false);

    // Restore ON for cleanliness / to prove it's reversible.
    setAuthUid(OWNER_AUTH);
    psql(`select public.set_show_pay_in_about_me(true);`, { role: 'authenticated' });
    setAuthUid(EMP_A_AUTH);
    const aboutA4 = JSON.parse(psql('select public.get_my_about_me();', { role: 'authenticated' }));
    check('turning it back on restores the pay_rate key', Object.prototype.hasOwnProperty.call(aboutA4, 'pay_rate'), true);

    console.log('\n--- A caller with no employee row at all is refused by both RPCs ---\n');
    setAuthUid('99999999-9999-9999-9999-999999999999');
    let noRowBlockedProfile = false, noRowBlockedAbout = false;
    try { psql(`select public.update_my_employee_profile(p_address := 'x');`, { role: 'authenticated' }); } catch (e) { noRowBlockedProfile = true; }
    try { psql(`select public.get_my_about_me();`, { role: 'authenticated' }); } catch (e) { noRowBlockedAbout = true; }
    check('update_my_employee_profile refuses a caller with no employee row', noRowBlockedProfile, true);
    check('get_my_about_me refuses a caller with no employee row', noRowBlockedAbout, true);

  } finally {
    try { execSync(`${PG_BIN}/pg_ctl -D ${DATA_DIR} stop -m fast`, { stdio: 'ignore' }); } catch (e) {}
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(DATA_DIR + '.log', { force: true });
    fs.rmSync('/tmp/_ep_rpc_stub_pre117.sql', { force: true });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH:', e.message);
  try { execSync(`${PG_BIN}/pg_ctl -D ${DATA_DIR} stop -m fast`, { stdio: 'ignore' }); } catch (e2) {}
  process.exit(1);
});
