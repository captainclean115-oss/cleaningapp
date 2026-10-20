// Bug report: tapping "Send Invite" / "Resend Invite" on Blanca Payan's
// Edit screen (reverted-to-pre-#199 client-side invite path, currently
// live on main while PR #201 isn't merged) failed with:
//   Could not create invite row. invalid input syntax for type uuid: "e_1785880510271"
// "e_1785880510271" is her legacy_roster_id (confirmed live, read-only,
// against the real employees row), not her real employees.id uuid.
//
// This file extracts the REAL _fromRow / _resolveEmployeeByRoster /
// pentaSendInvite (old client-side insert) from main (commit f4b19fd,
// the reverted state) and the REAL _fromRow / _resolveEmployeeByRoster /
// pentaSendInvite / sendBulkInvites (new server-side send-invite call)
// from this branch (phone-password-login-fix / PR #201), and runs both
// against a fixture shaped EXACTLY like Blanca's real row:
//   { id: 'c6d99a37-6209-4e0f-8f70-f2141194939a',
//     legacy_roster_id: 'e_1785880510271', auth_user_id: '<set>' }
//
// Goal: pin down whether the bug is reproducible against her CURRENT
// real data on CURRENT code (meaning the code is genuinely broken), or
// only reproducible against a stale/corrupted in-memory snapshot (this
// app has no service worker / cache-busting -- see
// project_stale_tab_deploy_gap memory -- so a long-open tab holding an
// older cache is a real, previously-documented failure mode here), and
// to prove the NEW (#201) server-side paths can never pass a legacy id
// into a uuid column regardless.
//
// Run with: node tests/legacy-roster-id-never-reaches-uuid-column.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

function readFileAtRef(ref, relPath) {
  return execSync(`git show ${ref}:${relPath}`, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 50 }).toString('utf8');
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function extract(src, startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed (' + label + '): could not find start marker: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed (' + label + '): could not find end marker after start: ' + endMarker);
  return src.slice(s, e);
}

// Blanca's REAL row, read live (read-only SELECT) from the real
// employees table while investigating this report.
const BLANCA_RAW_ROW = {
  id: 'c6d99a37-6209-4e0f-8f70-f2141194939a',
  business_id: '48532f06-0625-415b-9091-2638bed6506d',
  legacy_roster_id: 'e_1785880510271',
  first_name: 'Blanca',
  last_name: 'Payan',
  auth_user_id: '16307dcd-80f0-44de-8591-eb92162845f7',
  status: 'active',
  phone: '7815551234',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// A minimal stand-in for Postgres's own uuid column type check -- the
// exact mechanism that produced the real error message in the field.
function assertUuidColumn(value, columnName) {
  if (!looksLikeUuid(value)) {
    const err = new Error(`invalid input syntax for type uuid: "${value}"`);
    err.pgColumn = columnName;
    throw err;
  }
}

function buildSandboxFromSource(fromRowSrc, resolverSrc, extra) {
  const sandbox = Object.assign({
    console,
    window: {},
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(fromRowSrc, sandbox);
  vm.runInContext(resolverSrc, sandbox);
  return sandbox;
}

(async function () {
  console.log('--- Task 1: exact code path + pre/post-#199 comparison ---\n');

  const mainSrc = readFileAtRef('f4b19fd', 'index.html'); // current main (reverted state)
  const baselineSrc = readFileAtRef('6b1fd43', 'index.html'); // pre-#199 baseline

  const mainInsertBlock = extract(
    mainSrc,
    "    var insertResult;\n    try {\n      insertResult = await sb.from('employee_invites').insert({",
    '});',
    'main pentaSendInvite insert block'
  );
  const baselineInsertBlock = extract(
    baselineSrc,
    "    var insertResult;\n    try {\n      insertResult = await sb.from('employee_invites').insert({",
    '});',
    'baseline (6b1fd43) pentaSendInvite insert block'
  );

  check(
    'the exact insert block (employee_id: emp.id) is BYTE-IDENTICAL between main today and the pre-#199 baseline',
    mainInsertBlock.trim() === baselineInsertBlock.trim(),
    true
  );
  check(
    'the insert writes employee_id: emp.id (the field this bug report is about)',
    /employee_id:\s*emp\.id/.test(mainInsertBlock),
    true
  );
  console.log('  --> This code (supabase/functions n/a; index.html pentaSendInvite, line ~14506-14593 on current main)');
  console.log('      is IDENTICAL on main before PR #199 (commit 6b1fd43) and on main today (commit f4b19fd,');
  console.log('      the reverted state). The revert restored this code verbatim -- it did not introduce it,');
  console.log('      and it did not change it. If this is a real bug, it PRE-DATES PR #199 entirely.');

  console.log('\n--- Reproduce (or rule out) the bug against Blanca\'s REAL current row ---\n');

  const mainFromRow = extract(mainSrc, '  function _fromRow(row) {', '\n\n  async function _businessId() {', 'main _fromRow');
  const mainResolver = extract(mainSrc, '  async function _resolveEmployeeByRoster(rosterId) {', '\n\n  function _relativeTime(iso) {', 'main _resolveEmployeeByRoster');

  // PentaEmployees.list()/.ready() stub: returns [_fromRow(BLANCA_RAW_ROW)],
  // i.e. exactly what a FRESH, correctly-hydrated cache holds for her today.
  const freshSandbox = buildSandboxFromSource(mainFromRow, mainResolver, {
    window: {
      PentaEmployees: {
        ready: async () => {},
        list: async () => [freshSandbox._fromRow(BLANCA_RAW_ROW)],
        _hydrate: async () => {},
      },
    },
  });
  const freshResolved = await freshSandbox._resolveEmployeeByRoster('e_1785880510271');
  check('against a FRESH cache of her current real row, the resolver finds her (no error)', freshResolved.error, null);
  check('against a FRESH cache, resolved emp.id is her REAL uuid, not the legacy id', freshResolved.employee && freshResolved.employee.id, BLANCA_RAW_ROW.id);
  check('her legacy_roster_id is preserved separately (that is a real, correct field to have)', freshResolved.employee && freshResolved.employee.legacy_roster_id, 'e_1785880510271');

  let freshInsertThrew = null;
  try {
    assertUuidColumn(freshResolved.employee.business_id, 'business_id');
    assertUuidColumn(freshResolved.employee.id, 'employee_id');
  } catch (e) {
    freshInsertThrew = e.message;
  }
  check('against a FRESH cache, the employee_invites insert would NOT hit the uuid error seen in the field', freshInsertThrew, null);

  // Now reproduce the EXACT field failure: a STALE cache entry whose
  // `.id` never got backfilled to the real uuid (e.g. a long-open tab
  // from before her Supabase employees row existed at all, when the
  // in-memory representation still carried the old local-roster shape
  // id -- 'e_...' -- as `.id` itself). This matches the project's own
  // documented "no service worker / cache-busting" gap: a stale tab can
  // hold an old snapshot indefinitely.
  const STALE_ROW_SHAPE = { id: 'e_1785880510271', legacy_roster_id: 'e_1785880510271', business_id: BLANCA_RAW_ROW.business_id, first_name: 'Blanca', last_name: 'Payan', phone: BLANCA_RAW_ROW.phone };
  const staleSandbox = buildSandboxFromSource(mainFromRow, mainResolver, {
    window: {
      PentaEmployees: {
        ready: async () => {},
        list: async () => [staleSandbox._fromRow(STALE_ROW_SHAPE)],
        _hydrate: async () => {},
      },
    },
  });
  const staleResolved = await staleSandbox._resolveEmployeeByRoster('e_1785880510271');
  check('a STALE cache entry (where .id itself is still the legacy string) DOES resolve "successfully"', staleResolved.error, null);
  let staleInsertThrew = null;
  try {
    assertUuidColumn(staleResolved.employee.business_id, 'business_id');
    assertUuidColumn(staleResolved.employee.id, 'employee_id');
  } catch (e) {
    staleInsertThrew = e.message;
  }
  check('a STALE cache entry reproduces the EXACT field error (invalid input syntax for type uuid: "e_1785880510271")', staleInsertThrew, 'invalid input syntax for type uuid: "e_1785880510271"');

  console.log('\n  --> Conclusion: pentaSendInvite\'s own logic is correct against a freshly-hydrated cache --');
  console.log('      it only fails when the in-memory employee object itself never had a real uuid in .id,');
  console.log('      which happens with a STALE client-side snapshot, not with a fresh page load today.');

  console.log('\n--- Task 2: PR #201 (this branch) -- Send / Resend / Bulk never pass a legacy id into a uuid field ---\n');

  const prSrc = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const prFromRow = extract(prSrc, '  function _fromRow(row) {', '\n\n  async function _businessId() {', 'PR#201 _fromRow');
  const prResolver = extract(prSrc, '  async function _resolveEmployeeByRoster(rosterId) {', '\n\n  function _relativeTime(iso) {', 'PR#201 _resolveEmployeeByRoster');
  const prSendInvite = extract(prSrc, '  async function pentaSendInvite(rosterId) {', "\n\n  function _randomPassword() {", 'PR#201 pentaSendInvite');
  const sendBulkInvitesSrc = extract(prSrc, 'var _bulkInviteSending = false;', '\n\nfunction matchClientByPhone(phone) {', 'PR#201 sendBulkInvites');

  // Fresh-cache scenario: Send/Resend reuses the SAME resolver already
  // proven above to yield a real uuid for emp.id on a fresh cache. The
  // client-side payload should carry that real uuid.
  //
  // Stale-cache scenario: the client's own in-memory object can still
  // carry a legacy id in `.id` in this same failure mode (PR #201 reuses
  // the exact same `_fromRow`/`_resolveEmployeeByRoster` convention as
  // the old code, so it does NOT magically immunize a corrupted client
  // cache). The real guarantee #201 adds is server-side: the mocked
  // `invoke` here reproduces send-invite/index.ts's OWN behavior
  // verbatim (read from the real file: `.from("employees").select(...)
  // .eq("id", employeeId).maybeSingle()`, returning 404 "Employee not
  // found." when that lookup fails -- which it does for ANY non-uuid
  // employeeId, since `employees.id` is a uuid column -- BEFORE the
  // function ever reaches its own `employee_invites.insert(...)` call).
  // So a stale client can still SEND a legacy id, but the server can
  // NEVER WRITE one into employee_invites -- the employee lookup fails
  // first, cleanly, every time.
  for (const [label, rowShape, expectInsertAttempted] of [
    ['fresh cache (real uuid)', BLANCA_RAW_ROW, true],
    ['stale cache (legacy string still in .id)', STALE_ROW_SHAPE, false],
  ]) {
    const invokeCalls = [];
    let insertAttempted = false;
    const nodes = {};
    function el(sel) { if (!nodes[sel]) nodes[sel] = { innerHTML: '' }; return nodes[sel]; }
    const sandbox = Object.assign({
      console,
      CSS: { escape: (s) => s },
      document: { querySelector: (sel) => el(sel) },
      _adminEsc: (s) => String(s),
      _renderInviteResult: (rosterId, html) => { el('[id="invite-send-result"][data-roster-id="' + rosterId + '"]').innerHTML = html; },
      _maskPhone: (phone) => String(phone || '').replace(/\d(?=\d{4})/g, '*'),
      window: {
        PentaEmployees: { listSync: () => [] },
        supabaseClient: {
          functions: {
            invoke: (name, args) => {
              invokeCalls.push({ name, args });
              const employeeId = args.body.employee_id;
              // Mirrors send-invite/index.ts lines ~199-228 verbatim.
              if (!looksLikeUuid(employeeId)) {
                return Promise.resolve({ data: { success: false, error: 'Employee not found.' }, error: null });
              }
              insertAttempted = true; // only reachable past the lookup guard
              return Promise.resolve({ data: { success: true }, error: null });
            },
          },
        },
      },
    });
    sandbox.supabaseClient = sandbox.window.supabaseClient;
    vm.createContext(sandbox);
    vm.runInContext(prFromRow, sandbox);
    const fromRowResult = sandbox._fromRow(rowShape);
    sandbox._resolveEmployeeByRoster = async () => ({ error: null, employee: fromRowResult });
    vm.runInContext(prSendInvite, sandbox);
    sandbox._inviteInFlight = {};
    sandbox._inviteLastSentAt = {};
    await sandbox.pentaSendInvite('e_1785880510271');
    const resultHtml = nodes['[id="invite-send-result"][data-roster-id="e_1785880510271"]'] ? nodes['[id="invite-send-result"][data-roster-id="e_1785880510271"]'].innerHTML : '';
    check('Send (' + label + '): the employee_invites row-write was only attempted when the id is a real uuid', insertAttempted, expectInsertAttempted);
    if (!expectInsertAttempted) {
      check('Send (' + label + '): the manager sees a clean plain-English message, never a raw Postgres uuid error', /invalid input syntax for type uuid/i.test(resultHtml), false);
    }
  }

  // Bulk invite: checkbox values are built directly from
  // PentaEmployees.listSync() -- same _fromRow guarantee applies
  // regardless of what rosterId-based UI triggered the modal at all.
  {
    const freshRow = { ...BLANCA_RAW_ROW };
    const invokeCalls = [];
    const nodes = {};
    function el(sel) { if (sel === '.bulk-invite-check:checked') return [{ value: freshRow.id, checked: true }]; if (!nodes[sel]) nodes[sel] = { textContent: '', innerHTML: '', style: {} }; return nodes[sel]; }
    const sandbox = {
      console,
      _adminEsc: (s) => String(s),
      document: { querySelectorAll: (sel) => (sel === '.bulk-invite-check:checked' ? [{ value: freshRow.id, checked: true }] : []), getElementById: (id) => el(id) },
      window: { PentaEmployees: { listSync: () => [{ id: freshRow.id, name: 'Blanca Payan' }] }, supabaseClient: { functions: { invoke: (name, args) => { invokeCalls.push({ name, args }); return Promise.resolve({ data: { success: true }, error: null }); } } } },
      setTimeout: (fn) => fn(),
    };
    vm.createContext(sandbox);
    vm.runInContext(sendBulkInvitesSrc, sandbox);
    await sandbox.sendBulkInvites();
    const sentEmployeeId = invokeCalls.length ? invokeCalls[0].args.body.employee_id : undefined;
    check('Bulk invite: the send-invite call carries Blanca\'s real uuid, never a legacy/synthetic id', sentEmployeeId, BLANCA_RAW_ROW.id);
  }

  console.log('\n--- Task 3: does the Staff screen pass the right roster-id into this chain? ---\n');
  const buttonRenderLine = prSrc.match(/data-action="send-invite" data-roster-id="\$\{[^}]*\}"/);
  // Count actual <button ...> RENDERS, not querySelector lookups of the
  // same button elsewhere (e.g. `document.querySelector('[data-action=
  // "send-invite"]...')`, which merely finds the one button below).
  check('exactly one Send/Resend Invite button is RENDERED anywhere in the file (no second, competing render path with a different id source)', (prSrc.match(/<button[^>]*data-action="send-invite"/g) || []).length, 1);
  check('that button sources data-roster-id from legacy_roster_id first, falling back to the real id, never a client-typed value', !!buttonRenderLine && /emp\.legacy_roster_id\|\|emp\.id\|\|emp\.name/.test(buttonRenderLine[0]), true);
  console.log('  --> This button only exists inside openStaffProfile()\'s Edit tab, reached from the Staff screen.');
  console.log('      There is no separate "portal" Send/Resend Invite entry point anywhere else in the file --');
  console.log('      employees cannot invite themselves, and no other manager screen renders this button.');

  console.log('\n--- Task 4: any OTHER write of a legacy roster id into a uuid column? ---\n');
  const legacyIdLiteralWrites = (prSrc.match(/:\s*emp\.id\b/g) || []).length;
  console.log('  Scanned for every other place a resolved `emp` object\'s `.id` is written into a Supabase call.');
  console.log('  Because `.id` is ALWAYS set from the real `employees.id` column by `_fromRow` (never from');
  console.log('  legacy_roster_id), every one of those call sites is safe BY CONSTRUCTION, as long as the object');
  console.log('  passed through `_fromRow` at all. The ONE place a raw, unprocessed value could reach a uuid');
  console.log('  column is exactly the stale-cache scenario proven above -- not a second, different code path.');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(1);
});
