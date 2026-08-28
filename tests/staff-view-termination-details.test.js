// PR #151 -- regression test for "termination details not visible anywhere
// in the UI" bug report.
//
// Diagnosed live: the write path was already correct (verified against a
// real recent termination in the DB -- termination_reason, notes,
// terminated_by, eligible_for_rehire, terminated_at all present and
// correctly mapped by _fromRow). This was a pure display gap:
// renderStaffView() (the actual per-employee profile opened via
// "Staff > Show archived > click employee" -> openStaffProfile ->
// showStaffTab('view')) had zero termination-related markup at all --
// not even a reference to termination_reason/notes/terminated_by anywhere
// in the function. The archived-employee LIST rows (a different,
// separate render path) already showed a partial summary, which is why
// the bug wasn't "no data anywhere" but specifically "nothing on the
// employee's own card."
//
// Fix: a new "Termination Details" section in renderStaffView(), shown
// only for status='terminated', covering: date (bare DATE, formatted with
// local-time parsing to avoid the UTC-rollback bug), reason (human label),
// notes (if any), who terminated (async users lookup, terminated_by is a
// raw users.id), rehire eligibility (badge), and the actual action
// timestamp (async audit_log lookup -- terminated_at is only a date, the
// real "when" lives in the trigger-written audit_log row).
//
// Run with: node tests/staff-view-termination-details.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const reasonsSrc = extract('var TERMINATION_REASONS = [', '\nfunction _terminationReasonLabel', 'TERMINATION_REASONS');
const reasonLabelFn = extract('function _terminationReasonLabel(value) {', '\n}\n', '_terminationReasonLabel') + '\n}\n';
const fmtDateFn = extract('function _pentaFormatDateOnly(dateStr) {', '\n}\n', '_pentaFormatDateOnly') + '\n}\n';
const metaBlockSrc = extract('var _pentaUserNameCache = {};', '\n\n// Deliberately does NOT reuse PentaEmployees.archive()', 'terminationMeta block');
const renderStaffViewFn = extract('function renderStaffView() {', '\n// Sprint 8: keyed by form UUID', 'renderStaffView');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// --- _pentaFormatDateOnly: no UTC-rollback ---
{
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(fmtDateFn, sandbox);
  const formatted = sandbox._pentaFormatDateOnly('2026-08-25');
  check('_pentaFormatDateOnly does not roll back a day (UTC-midnight parse bug)', formatted.indexOf('24') === -1, true);
  check('_pentaFormatDateOnly formats the correct day', formatted.indexOf('25') !== -1, true);
}

// --- renderStaffView: the actual per-employee card ---
function buildViewSandbox(emp) {
  const elements = {
    'staff-edit-idx': { value: '0' },
    'staff-view-content': { innerHTML: '' },
  };
  const sandbox = {
    console,
    localStorage: { getItem: () => null },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
    },
    window: { PentaTeams: null },
    CSS: { escape: (s) => s },
    getStaffList: () => [emp],
    isPermitted: () => true,
    _renderStaffActivitySection: () => {},
    renderStaffViewFormsPreview: () => {},
    applyPermissions: () => {},
    _renderStaffTerminationMeta: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(reasonsSrc + '\n' + reasonLabelFn + '\n' + fmtDateFn, sandbox);
  vm.runInContext(renderStaffViewFn, sandbox);
  sandbox.renderStaffView();
  return elements['staff-view-content'].innerHTML;
}

const terminatedEmp = {
  id: 'emp-uuid-1', name: 'Deysi A', status: 'terminated',
  terminated_at: '2026-08-25', termination_reason: 'termination_performance',
  termination_notes: 'does not follow rules', terminated_by: 'user-uuid-1',
  eligible_for_rehire: true,
};
const html = buildViewSandbox(terminatedEmp);

check('Termination Details section appears for a terminated employee', html.includes('Termination Details'), true);
check('the formatted termination date is shown', html.includes('Aug 25, 2026'), true);
check('the human-readable reason label is shown, not the raw enum value', html.includes('Termination — performance'), true);
check('the raw enum value is NOT shown unlabeled', html.includes('>termination_performance<'), false);
check('termination notes are shown', html.includes('does not follow rules'), true);
check('a "terminated by" placeholder exists for the async user-name paint', html.includes('id="staff-view-terminated-by"'), true);
check('a "terminated timestamp" placeholder exists for the async audit_log paint', html.includes('id="staff-view-terminated-timestamp"'), true);
check('eligible-for-rehire renders as a green Yes badge', html.includes('✓ Yes'), true);

const notEligibleEmp = Object.assign({}, terminatedEmp, { eligible_for_rehire: false });
const html2 = buildViewSandbox(notEligibleEmp);
check('eligible_for_rehire=false renders as a red No badge', html2.includes('✗ No'), true);

const activeEmp = { id: 'emp-uuid-2', name: 'Active Employee', status: 'active' };
const html3 = buildViewSandbox(activeEmp);
check('an ACTIVE employee never shows the Termination Details section', html3.includes('Termination Details'), false);

// --- _renderStaffTerminationMeta: the two async lookups ---
function buildMetaSandbox(userRow, auditRow) {
  const elements = {
    'staff-view-terminated-by': { textContent: '' },
    'staff-view-terminated-timestamp': { textContent: '' },
  };
  const calls = { usersEq: null, auditEq: [] };
  const sandbox = {
    console,
    document: { getElementById: (id) => elements[id] || null },
    window: {
      supabaseClient: {
        from: (table) => {
          if (table === 'users') {
            return {
              select: () => ({
                eq: (col, val) => { calls.usersEq = [col, val]; return { maybeSingle: () => Promise.resolve({ data: userRow, error: null }) }; },
              }),
            };
          }
          if (table === 'audit_log') {
            const chain = {
              eq: (col, val) => { calls.auditEq.push([col, val]); return chain; },
              order: () => chain,
              limit: () => chain,
              maybeSingle: () => Promise.resolve({ data: auditRow, error: null }),
            };
            return { select: () => chain };
          }
          throw new Error('unexpected table ' + table);
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(metaBlockSrc, sandbox);
  return { sandbox, elements, calls };
}

(async () => {
  const { sandbox, elements, calls } = buildMetaSandbox(
    { first_name: 'Tom', last_name: 'Manna', email: 'captainclean115@gmail.com' },
    { created_at: '2026-08-28T01:16:07.776386+00:00' }
  );
  await sandbox._renderStaffTerminationMeta({ id: 'emp-uuid-1', terminated_by: 'user-uuid-tom' });

  check('"terminated by" resolves the users.id to a real name, not the raw uuid', elements['staff-view-terminated-by'].textContent, 'Tom Manna');
  check('the users lookup queries by the correct id column', calls.usersEq, ['id', 'user-uuid-tom']);
  check('"terminated timestamp" is the real audit_log created_at, formatted -- not the bare terminated_at date', elements['staff-view-terminated-timestamp'].textContent.indexOf('2026') !== -1, true);
  check('the audit_log lookup is scoped to this employee\'s "terminated" action on the "employee" entity', calls.auditEq, [['entity_type', 'employee'], ['entity_id', 'emp-uuid-1'], ['action_type', 'terminated']]);

  // No terminated_by (legacy/edge case) -- must not attempt a lookup or leave "Loading…" stuck.
  const { sandbox: sandbox2, elements: elements2 } = buildMetaSandbox(null, null);
  elements2['staff-view-terminated-by'].textContent = 'Loading…';
  await sandbox2._renderStaffTerminationMeta({ id: 'emp-uuid-2', terminated_by: null });
  check('with no terminated_by, the placeholder is left alone rather than queried (caller already renders "—" synchronously)', elements2['staff-view-terminated-by'].textContent, 'Loading…');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
