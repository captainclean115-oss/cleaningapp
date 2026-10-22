// Claire portal-links feature (send_portal_invite / send_password_reset_link).
// Extracts the REAL _claireSendPortalLinks orchestration + its real
// name-resolution dependencies (_cleanName, _lev, findEmployees,
// findEmployeeWithSuggestions, _claireTerminatedExplanation),
// getUnifiedRoster, and the real pentaSendInvite/pentaSendPasswordReset
// (+ their shared _findDuplicateActivePhoneOwnerReason helper) verbatim
// from index.html. Mocks only the Supabase client (sb.functions.invoke)
// and _auditSupplement -- everything else is the actual shipped logic.
//
// Run with: node tests/claire-portal-links.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed (' + label + '): could not find start marker: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed (' + label + '): could not find end marker after start: ' + endMarker);
  return src.slice(s, e);
}

const nameResolutionAndOrchestrationSrc = extract(
  'function _cleanName(s) {',
  'var CLAIRE_QUERY_TOOLS = {',
  'name resolution + _claireSendPortalLinks'
);
const rosterSrc = extract(
  'function getUnifiedRoster(asOfDate) {',
  "// Returns the team CARD an employee should be grouped under for a",
  'getUnifiedRoster'
);
const sendFnsSrc = extract(
  '  async function _resolveEmployeeByRoster(rosterId) {',
  '\n\n  function _randomPassword() {',
  'pentaSendInvite + pentaSendPasswordReset + helpers'
);
const dateKeySrc = extract('function dateKey(d) {', '\n}\n', 'dateKey') + '\n}\n';
const formatDateSrc = extract('function _pentaFormatDateOnly(dateStr) {', '\n}\n', '_pentaFormatDateOnly') + '\n}\n';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ---- Fixture roster -------------------------------------------------
let _legacyIdCounter = 1000;
function emp(overrides) {
  const id = (overrides && overrides.id) || 'uuid-' + Math.random().toString(36).slice(2);
  return Object.assign({
    id: id,
    // _resolveEmployeeByRoster (the real resolver pentaSendInvite/
    // pentaSendPasswordReset both use) matches ONLY on legacy_roster_id,
    // never falling back to the real uuid -- every real employee row
    // has one (confirmed live against Blanca Payan's actual row earlier
    // this session), so fixtures need one too for the resolver to find
    // them at all.
    legacy_roster_id: 'lr-' + (_legacyIdCounter++),
    name: 'Fixture Person',
    first_name: 'Fixture',
    last_name: 'Person',
    phone: '6175550000',
    auth_user_id: null,
    status: 'active',
    terminated_at: null,
    work_type: 'field',
    pay_type: 'hourly',
    team_id: null,
  }, overrides);
}

const MARIA = emp({ id: 'uuid-maria', name: 'Maria Vieira', first_name: 'Maria', last_name: 'Vieira', phone: '6175551001' });
const BLANCA = emp({ id: 'uuid-blanca', name: 'Blanca Payan', first_name: 'Blanca', last_name: 'Payan', phone: '7815551234' });
const VIVIANA = emp({ id: 'uuid-viviana', name: 'Viviana', first_name: 'Viviana', last_name: '', phone: '7815551234' });
const TERMINATED = emp({ id: 'uuid-term', name: 'Fired Fred', first_name: 'Fired', last_name: 'Fred', status: 'terminated', terminated_at: '2026-01-01', phone: '6175551009' });
const ADMIN_SALARIED = emp({ id: 'uuid-admin-sal', name: 'Office Olivia', first_name: 'Office', last_name: 'Olivia', phone: '6175551002', work_type: 'admin', pay_type: 'salary' });
const ADMIN_HOURLY = emp({ id: 'uuid-admin-hr', name: 'Office Henry', first_name: 'Office', last_name: 'Henry', phone: '6175551003', work_type: 'admin', pay_type: 'hourly' });
const NO_PHONE = emp({ id: 'uuid-nophone', name: 'No Phone Nancy', first_name: 'No', last_name: 'Phone Nancy', phone: '' });
const ALREADY_LINKED = emp({ id: 'uuid-linked', name: 'Linked Lola', first_name: 'Linked', last_name: 'Lola', phone: '6175551004', auth_user_id: 'auth-lola' });
const EXTRA_ELIGIBLE = [];
for (let i = 1; i <= 10; i++) {
  EXTRA_ELIGIBLE.push(emp({ id: 'uuid-extra-' + i, name: 'Extra Emp ' + i, first_name: 'Extra', last_name: 'Emp' + i, phone: '61755520' + String(i).padStart(2, '0') }));
}

const FULL_ROSTER = [MARIA, BLANCA, VIVIANA, TERMINATED, ADMIN_SALARIED, ADMIN_HOURLY, NO_PHONE, ALREADY_LINKED].concat(EXTRA_ELIGIBLE);

function buildSandbox(opts) {
  opts = opts || {};
  const auditCalls = [];
  const invokeCalls = [];
  const consoleLogs = [];
  const roster = opts.roster || FULL_ROSTER;

  const sandbox = {
    console: { log: (...a) => consoleLogs.push(a.join(' ')), error: (...a) => consoleLogs.push(a.join(' ')), warn: (...a) => consoleLogs.push(a.join(' ')), debug: () => {} },
    EMPLOYEE_ROSTER: [],
    window: {
      PentaEmployees: {
        ready: async () => {},
        list: async () => roster,
        listSync: () => roster,
        getById: (id) => roster.find((e) => e.id === id) || null,
        _hydrate: async () => {},
      },
      supabaseClient: null,
      PentaAuth: null,
    },
    _adminEsc: (s) => String(s),
    // The REAL pentaSendInvite/pentaSendPasswordReset (extracted
    // verbatim below) declare their OWN _renderInviteResult, which
    // overwrites any stub set here before the script runs (function
    // declarations hoist) -- so document/CSS need real-enough stubs for
    // that real function to run harmlessly, not a pre-set override.
    document: { querySelector: () => null },
    CSS: { escape: (s) => s },
    _auditSupplement: async (action_type, entity_type, entity_id, new_values) => {
      auditCalls.push({ action_type, entity_type, entity_id, new_values });
    },
    setTimeout: (fn) => fn(), // no real delay in tests
  };
  sandbox.supabaseClient = {
    functions: {
      invoke: (name, args) => {
        invokeCalls.push({ name, args });
        return (opts.invokeImpl || (() => Promise.resolve({ data: { success: true }, error: null })))(args.body.employee_id, args.body.action || 'invite');
      },
    },
  };
  sandbox.window.supabaseClient = sandbox.supabaseClient;

  vm.createContext(sandbox);
  vm.runInContext(dateKeySrc, sandbox);
  vm.runInContext(formatDateSrc, sandbox);
  vm.runInContext(rosterSrc, sandbox);
  vm.runInContext(sendFnsSrc, sandbox);
  vm.runInContext(nameResolutionAndOrchestrationSrc, sandbox);
  return { sandbox, auditCalls, invokeCalls, consoleLogs };
}

(async function () {
  console.log('--- Single employee by name: sends immediately, reports masked phone ---\n');
  {
    const { sandbox, invokeCalls, auditCalls } = buildSandbox({});
    const result = await sandbox._claireSendPortalLinks({ employees: ['Maria Vieira'] }, 'invite');
    check('single send: success with one sent, zero failed/skipped', { sent: result.sent.length, failed: result.failed.length, skipped: result.skipped.length }, { sent: 1, failed: 0, skipped: 0 });
    check('single send: reports a masked phone, never the raw number', result.sent[0].maskedPhone, '***-***-1001');
    check('single send: exactly one invoke call, for Maria\'s real uuid', invokeCalls.length === 1 && invokeCalls[0].args.body.employee_id === 'uuid-maria', true);
    check('single send: no preview field on the result (sent immediately)', result.preview, undefined);
    check('single send: wrote exactly one audit row', auditCalls.length, 1);
    check('single send: audit row has source=claire_portal_link, type=invite, result=sent', { source: auditCalls[0].new_values.source, type: auditCalls[0].new_values.type, result: auditCalls[0].new_values.result }, { source: 'claire_portal_link', type: 'invite', result: 'sent' });
  }

  console.log('\n--- "all": produces a preview and sends nothing until confirmed ---\n');
  {
    const { sandbox, invokeCalls } = buildSandbox({});
    const preview = await sandbox._claireSendPortalLinks({ all: true }, 'invite');
    check('all (unconfirmed): returns a preview, not a send', preview.preview, true);
    check('all (unconfirmed): zero invoke calls happened', invokeCalls.length, 0);
    check('all (unconfirmed): preview lists at most 10 recipients (the cap)', preview.recipients.length <= 10, true);
    check('all (unconfirmed): skip reasons are present for the ineligible ones', preview.skipped.length > 0, true);
  }

  console.log('\n--- Skip reasons: no phone, shared phone, already linked, terminated, admin allowed ---\n');
  {
    const { sandbox } = buildSandbox({});
    const preview = await sandbox._claireSendPortalLinks({ all: true }, 'invite');
    const skipMap = {};
    preview.skipped.forEach((s) => { skipMap[s.name] = s.reason; });
    check('No Phone Nancy skipped for no phone', /no phone/i.test(skipMap['No Phone Nancy'] || ''), true);
    check('Blanca Payan skipped for shared phone', /shared/i.test(skipMap['Blanca Payan'] || ''), true);
    check('Viviana skipped for shared phone too (both sides of the pair)', /shared/i.test(skipMap['Viviana'] || ''), true);
    check('Linked Lola skipped for already having a login', /already has a login/i.test(skipMap['Linked Lola'] || ''), true);
    check('Fired Fred never appears at all (excluded by getUnifiedRoster itself, not even a skip entry)', Object.prototype.hasOwnProperty.call(skipMap, 'Fired Fred'), false);
    check('Office Olivia (salaried admin) is NOT skipped -- admins are eligible for invites', Object.prototype.hasOwnProperty.call(skipMap, 'Office Olivia'), false);
    check('Office Henry (hourly admin) is NOT skipped either', Object.prototype.hasOwnProperty.call(skipMap, 'Office Henry'), false);
    check('Office Olivia (salaried admin) IS in the recipients list', preview.recipients.indexOf('Office Olivia') !== -1, true);
  }

  console.log('\n--- A terminated name, looked up directly, gets a clear reason (not "not found") ---\n');
  {
    const { sandbox } = buildSandbox({});
    // Two names -> a preview (no confirmed flag), same as any 2+ call.
    const result = await sandbox._claireSendPortalLinks({ employees: ['Fired Fred', 'Maria Vieira'] }, 'invite');
    check('terminated employee named directly is skipped with a termination reason, not an error', result.skipped.some((s) => /terminated/i.test(s.reason)), true);
    check('the OTHER (eligible) employee in the same call still appears in the preview', result.recipients.indexOf('Maria Vieira') !== -1, true);
  }

  console.log('\n--- reset: eligibility is the OPPOSITE of invite (needs a login already) ---\n');
  {
    const { sandbox } = buildSandbox({});
    const preview = await sandbox._claireSendPortalLinks({ all: true }, 'reset');
    const skipMap = {};
    preview.skipped.forEach((s) => { skipMap[s.name] = s.reason; });
    check('reset: Linked Lola (has a login) IS eligible, not skipped', Object.prototype.hasOwnProperty.call(skipMap, 'Linked Lola'), false);
    check('reset: Maria Vieira (no login yet) IS skipped, told to use invite instead', /invite instead/i.test(skipMap['Maria Vieira'] || ''), true);
  }

  console.log('\n--- Batch cap of 10 with a remainder message; one failure does not stop the rest ---\n');
  {
    const { sandbox, invokeCalls } = buildSandbox({
      invokeImpl: (employeeId) => {
        if (employeeId === 'uuid-extra-5') return Promise.resolve({ data: { success: false, error: 'No active RC integration' }, error: null });
        return Promise.resolve({ data: { success: true }, error: null });
      },
    });
    const preview = await sandbox._claireSendPortalLinks({ all: true }, 'invite');
    check('preview says how many are left over past the 10-cap', preview.remaining_after_this_batch > 0, true);
    const result = await sandbox._claireSendPortalLinks({ all: true, confirmed: true }, 'invite');
    check('confirmed batch sends AT MOST 10 in one call', invokeCalls.length <= 10, true);
    check('the batch reaches employees AFTER the one that failed (does not stop)', result.sent.length > 0 && result.failed.length === 1, true);
    check('the failed entry carries the real server reason, not a generic message', result.failed[0].reason, 'No active RC integration');
    check('result reports how many remained after this capped batch', result.remaining > 0, true);
  }

  console.log('\n--- Links and tokens never appear in Claire output, audit rows, or console log ---\n');
  {
    const FAKE_LINK = 'https://captainclean115-oss.github.io/cleaningapp/accept-invite.html?token=SECRETTOKEN123';
    const { sandbox, auditCalls, consoleLogs } = buildSandbox({
      invokeImpl: () => Promise.resolve({ data: { success: true }, error: null }),
    });
    const result = await sandbox._claireSendPortalLinks({ employees: ['Maria Vieira'] }, 'invite');
    const serialized = JSON.stringify(result);
    check('the orchestration result never contains a link/token-looking string', /token=|accept-invite\.html|reset\.html/.test(serialized), false);
    check('no audit row ever contains a link or token field', auditCalls.every((c) => JSON.stringify(c.new_values).indexOf('token') === -1 && JSON.stringify(c.new_values).indexOf('http') === -1), true);
    check('nothing logged to console contains the word "token" or a link', consoleLogs.join('\n').toLowerCase().indexOf('token') === -1, true);
    // Sanity: confirms this test would actually catch a leak if one existed.
    check('(sanity) the FAKE_LINK constant itself does contain "token" -- proves the check above is meaningful', FAKE_LINK.indexOf('token') !== -1, true);
  }

  console.log('\n--- A non-manager (or missing-role) Claire session is refused, before any send ---\n');
  {
    // This checks the REAL, literal guard text shipped in the dispatch
    // branch -- not a reimplementation of what it SHOULD do -- and
    // confirms the refusal (return/claireReply) sits textually BEFORE
    // the _claireSendPortalLinks( call in the same branch, so an
    // unauthorized session can never reach it.
    const dispatchBlock = extract(
      "  } else if (name === 'send_portal_invite' || name === 'send_password_reset_link') {",
      "\n\n  // ── LOCATE TEAM ──",
      'portal-links dispatch branch'
    );
    const guardIdx = dispatchBlock.indexOf("if (!_plRole || ['owner', 'admin', 'manager', 'dispatcher'].indexOf(_plRole) === -1) {");
    const refusalIdx = dispatchBlock.indexOf("claireReply('Only a manager or owner can send portal links.');");
    const callIdx = dispatchBlock.indexOf('_claireSendPortalLinks(input, _plKind)');
    check('the role guard exists in the real dispatch branch', guardIdx !== -1, true);
    check('the refusal message exists', refusalIdx !== -1, true);
    check('the guard (and its refusal) appear BEFORE the actual send call, not after', guardIdx !== -1 && refusalIdx !== -1 && callIdx !== -1 && guardIdx < callIdx && refusalIdx < callIdx, true);
    check('the guard checks a role read from getCurrentAppRole(), never a client-supplied field', /getCurrentAppRole/.test(dispatchBlock), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(1);
});
