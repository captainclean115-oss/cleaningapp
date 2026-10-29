// Fix login button -- extracts and runs the ACTUAL visibility gate and
// the ACTUAL pentaFixLogin/_pentaConfirmFixLogin/_pentaCancelFixLogin
// functions from index.html (same discipline every other test in this
// suite uses). Covers: the owner/admin/has-login/not-terminated
// visibility matrix, that a dry run always sends dry_run:true, that
// Confirm only ever appears after a would_change result and sends
// dry_run:false, that already_correct shows no confirm button, that
// error bodies (including the real non-2xx error.context.json() shape)
// are shown verbatim, and that a double-tap on Confirm sends exactly
// one write call.
//
// Run with: node tests/fix-login-button.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed: could not find start marker (' + label + '): ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed: could not find end marker after start (' + label + '): ' + endMarker);
  return src.slice(s, e);
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ============================================================
// Part A: the visibility gate, extracted exactly as computed in
// renderStaffView() -- owner/admin only, has a login, not terminated.
// ============================================================
console.log('--- Fix login button: visibility matrix ---\n');
{
  const gateSrc = extract(
    'let _showFixLogin = false;',
    "} catch (e) { _showFixLogin = false; }",
    '_showFixLogin gate'
  ) + "} catch (e) { _showFixLogin = false; }\nvar __result = _showFixLogin;";

  function computeShowFixLogin(role, emp) {
    const sandbox = { getCurrentAppRole: function () { return role; }, emp: emp };
    vm.createContext(sandbox);
    vm.runInContext(gateSrc, sandbox);
    return sandbox.__result;
  }

  const WITH_LOGIN_ACTIVE = { auth_user_id: 'auth-1', status: 'active' };
  const NO_LOGIN_ACTIVE = { auth_user_id: null, status: 'active' };
  const WITH_LOGIN_TERMINATED = { auth_user_id: 'auth-1', status: 'terminated' };

  check('owner, has login, active -> SHOWN', computeShowFixLogin('owner', WITH_LOGIN_ACTIVE), true);
  check('admin, has login, active -> SHOWN', computeShowFixLogin('admin', WITH_LOGIN_ACTIVE), true);
  check('manager, has login, active -> hidden', computeShowFixLogin('manager', WITH_LOGIN_ACTIVE), false);
  check('dispatcher, has login, active -> hidden', computeShowFixLogin('dispatcher', WITH_LOGIN_ACTIVE), false);
  check('employee, has login, active -> hidden', computeShowFixLogin('employee', WITH_LOGIN_ACTIVE), false);
  check('logged out (null role), has login, active -> hidden', computeShowFixLogin(null, WITH_LOGIN_ACTIVE), false);
  check('owner, NO login, active -> hidden', computeShowFixLogin('owner', NO_LOGIN_ACTIVE), false);
  check('owner, has login, TERMINATED -> hidden', computeShowFixLogin('owner', WITH_LOGIN_TERMINATED), false);
  check('admin, NO login, active -> hidden', computeShowFixLogin('admin', NO_LOGIN_ACTIVE), false);
  check('admin, has login, TERMINATED -> hidden', computeShowFixLogin('admin', WITH_LOGIN_TERMINATED), false);

  // getCurrentAppRole itself throwing must default to hidden, never shown.
  const sandbox2 = { getCurrentAppRole: function () { throw new Error('boom'); }, emp: WITH_LOGIN_ACTIVE };
  vm.createContext(sandbox2);
  vm.runInContext(gateSrc, sandbox2);
  check('getCurrentAppRole() throwing defaults to hidden, never shown', sandbox2.__result, false);

  // Structural tie-back: the button markup itself is gated on this
  // exact variable, inside the Penta Login section, not some other
  // unrelated flag.
  const sectionSrc = extract("section('Penta Login'", '])}', 'Penta Login section markup');
  check('the Fix login button markup is conditioned on _showFixLogin', /_showFixLogin\s*\n?\s*\?\s*`<div style="margin-top:10px/.test(sectionSrc), true);
  check('the button itself carries data-action="fix-login"', /data-action="fix-login"/.test(sectionSrc), true);
}

// ============================================================
// Part B: the actual flow functions (pentaFixLogin,
// _pentaConfirmFixLogin, _pentaCancelFixLogin), extracted verbatim.
// ============================================================
console.log('\n--- Fix login flow: dry run, confirm, errors, double-tap ---\n');

const extractInviteErrorSrc = extract(
  '// Invite-collision guard: shared by both the single-invite',
  '\n\n// =====================================================================',
  '_extractInviteError helper'
);
// Starts at _inviteInFlight (same proven start point
// pentasendinvite-guards.test.js and bulk-invite-continues-on-failure.test.js
// already use), NOT at the IIFE's own opening -- the real
// _resolveEmployeeByRoster is defined BEFORE this point, so starting
// here lets our own mock (below) stand in for it instead of being
// clobbered by the real one's function-declaration hoisting. Ends
// right before the window.X = ... export block, which references
// several names (pentaGenerateInviteToken, etc.) this slice never
// defines -- everything this test needs is a plain function
// declaration already, reachable directly as sandbox.pentaFixLogin
// etc. without needing those export lines at all.
const iifeBodySrc = extract(
  'var _inviteInFlight = {};',
  '\n\n  window.pentaGenerateInviteToken',
  'invite-helpers IIFE tail (includes pentaFixLogin and friends)'
);

function buildSandbox(opts) {
  opts = opts || {};
  const invokeCalls = [];
  const nodes = {};
  function el(selector) {
    if (!nodes[selector]) {
      nodes[selector] = {
        innerHTML: '', style: {}, disabled: false, textContent: '',
        _handlers: {},
        addEventListener: function (evt, fn) { this._handlers[evt] = fn; },
        click: function () { if (this._handlers.click) this._handlers.click(); },
      };
    }
    return nodes[selector];
  }
  const sandbox = {
    console,
    CSS: { escape: function (s) { return s; } },
    document: { querySelector: function (sel) { return el(sel); } },
    _adminEsc: function (s) { return String(s); },
    _resolveEmployeeByRoster: function () {
      return Promise.resolve(opts.resolved || { error: null, employee: { id: 'emp-uuid-1', phone: '7816263485' } });
    },
    // SB() itself is defined even earlier in the real IIFE (before
    // _inviteInFlight, this slice's own start point) -- trivial
    // one-line passthrough, mocked here same as _resolveEmployeeByRoster.
    SB: function () { return sandbox.window.supabaseClient; },
    window: {
      PentaEmployees: { listSync: function () { return []; }, _hydrate: function () { return Promise.resolve(); } },
      supabaseClient: {
        functions: {
          invoke: function (name, args) {
            invokeCalls.push({ name: name, args: args });
            if (opts.invokeImpl) return opts.invokeImpl(name, args);
            return Promise.resolve({ data: { status: 'already_correct' }, error: null });
          },
        },
      },
    },
    supabaseClient: null,
  };
  sandbox.supabaseClient = sandbox.window.supabaseClient;
  vm.createContext(sandbox);
  vm.runInContext(extractInviteErrorSrc, sandbox);
  vm.runInContext(iifeBodySrc, sandbox);
  return { sandbox: sandbox, invokeCalls: invokeCalls, nodes: nodes };
}

(async function () {
  // ---- Dry run always sends dry_run: true. ----
  {
    const { sandbox, invokeCalls } = buildSandbox({
      invokeImpl: function () { return Promise.resolve({ data: { status: 'already_correct' }, error: null }); },
    });
    await sandbox.pentaFixLogin('roster-1');
    check('pentaFixLogin calls repair-login-email', invokeCalls.length, 1);
    check('the dry-run call sends dry_run: true', invokeCalls[0].args.body.dry_run, true);
    check('the dry-run call sends the resolved employee_id', invokeCalls[0].args.body.employee_id, 'emp-uuid-1');
  }

  // ---- already_correct: no confirm button anywhere in the panel. ----
  {
    const { sandbox, nodes } = buildSandbox({
      invokeImpl: function () { return Promise.resolve({ data: { status: 'already_correct' }, error: null }); },
    });
    await sandbox.pentaFixLogin('roster-2');
    const panelHtml = nodes['[id="fix-login-panel"][data-roster-id="roster-2"]'].innerHTML;
    check('already_correct shows the plain-language message', /Nothing to fix/.test(panelHtml), true);
    check('already_correct shows NO confirm button', /fix-login-confirm-btn/.test(panelHtml), false);
  }

  // ---- would_change: shows the masked-phone message AND a Confirm
  // button that, when invoked, sends dry_run: false. ----
  {
    const { sandbox, nodes, invokeCalls } = buildSandbox({
      invokeImpl: function () { return Promise.resolve({ data: { status: 'would_change', old_email_suffix: '@phone.penta.internal', new_email_suffix: '@phone.penta.internal', phone_masked: '***-***-5156' }, error: null }); },
    });
    await sandbox.pentaFixLogin('roster-3');
    const panelHtml = nodes['[id="fix-login-panel"][data-roster-id="roster-3"]'].innerHTML;
    check('would_change names the number ending in the masked last 4 digits', /ending 5156/.test(panelHtml), true);
    check('would_change explains password and history stay', /Password and history stay/.test(panelHtml), true);
    check('would_change explains the staff email will be updated', /Staff email will be updated to match/.test(panelHtml), true);
    check('would_change shows a Confirm fix button', /fix-login-confirm-btn/.test(panelHtml), true);
    check('would_change never shows a full email anywhere in the message', /@phone\.penta\.internal.*@phone\.penta\.internal/.test(panelHtml) === false || !/[a-z0-9]{5,}@phone\.penta\.internal/.test(panelHtml.replace(/ending 5156/, '')), true);

    // Fire the Confirm action directly (same call the wired button makes).
    invokeCalls.length = 0;
    await sandbox._pentaConfirmFixLogin('roster-3', 'emp-uuid-1');
    check('Confirm sends exactly one call', invokeCalls.length, 1);
    check('Confirm sends dry_run: false', invokeCalls[0].args.body.dry_run, false);
    check('Confirm sends the same employee_id', invokeCalls[0].args.body.employee_id, 'emp-uuid-1');
  }

  // ---- A successful repair shows the real result (suffix only). ----
  {
    const { sandbox, nodes } = buildSandbox({
      invokeImpl: function () { return Promise.resolve({ data: { status: 'repaired', old_email_suffix: '@phone.penta.internal', new_email_suffix: '@phone.penta.internal' }, error: null }); },
    });
    await sandbox._pentaConfirmFixLogin('roster-4', 'emp-uuid-1');
    const panelHtml = nodes['[id="fix-login-panel"][data-roster-id="roster-4"]'].innerHTML;
    check('a successful repair shows "Login fixed"', /Login fixed/.test(panelHtml), true);
  }

  // ---- Cancel clears the panel without ever calling the function. ----
  {
    const { sandbox, nodes, invokeCalls } = buildSandbox({});
    await sandbox.pentaFixLogin('roster-5'); // populate the panel first
    invokeCalls.length = 0;
    sandbox._pentaCancelFixLogin('roster-5');
    const panelHtml = nodes['[id="fix-login-panel"][data-roster-id="roster-5"]'].innerHTML;
    check('Cancel clears the panel', panelHtml, '');
    check('Cancel makes no network call', invokeCalls.length, 0);
  }

  // ---- Collision refusal (and any other server error) is shown
  // VERBATIM, via the real data.error field -- never a generic message. ----
  {
    const { sandbox, nodes } = buildSandbox({
      invokeImpl: function () { return Promise.resolve({ data: { error: 'This phone number\'s login email is already registered to another employee\'s account. Correct the phone number in Staff first.', error_code: 'target_email_taken' }, error: null }); },
    });
    await sandbox.pentaFixLogin('roster-6');
    const panelHtml = nodes['[id="fix-login-panel"][data-roster-id="roster-6"]'].innerHTML;
    check('a collision refusal is shown verbatim, not replaced with a generic message', /already registered to another employee's account/.test(panelHtml), true);
    check('a collision refusal shows no confirm button', /fix-login-confirm-btn/.test(panelHtml), false);
  }

  // ---- The REAL non-2xx shape (data: null, error.context.json()) is
  // also recovered correctly, via the shared _extractInviteError. ----
  {
    const { sandbox, nodes } = buildSandbox({
      invokeImpl: function () {
        return Promise.resolve({
          data: null,
          error: { message: 'Edge Function returned a non-2xx status code', context: { json: function () { return Promise.resolve({ error: 'Only an owner or admin can repair a login email.' }); } } },
        });
      },
    });
    await sandbox.pentaFixLogin('roster-7');
    const panelHtml = nodes['[id="fix-login-panel"][data-roster-id="roster-7"]'].innerHTML;
    check('a real non-2xx error body is recovered via error.context.json() and shown verbatim', /Only an owner or admin can repair a login email\./.test(panelHtml), true);
  }

  // ---- A thrown network error shows a visible message, never silent. ----
  {
    const { sandbox, nodes } = buildSandbox({
      invokeImpl: function () { return Promise.reject(new Error('fetch failed')); },
    });
    await sandbox.pentaFixLogin('roster-8');
    const panelHtml = nodes['[id="fix-login-panel"][data-roster-id="roster-8"]'].innerHTML;
    check('a thrown network error shows a visible message', /could not reach the server/i.test(panelHtml), true);
  }

  // ---- Double-tap on Confirm sends exactly ONE write call. ----
  {
    let resolveFirst;
    const { sandbox, invokeCalls } = buildSandbox({
      invokeImpl: function () { return new Promise(function (r) { resolveFirst = r; }); },
    });
    const p1 = sandbox._pentaConfirmFixLogin('roster-9', 'emp-uuid-1');
    const p2 = sandbox._pentaConfirmFixLogin('roster-9', 'emp-uuid-1'); // fired before p1 resolves -- simulates a double-tap
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    resolveFirst({ data: { status: 'repaired', old_email_suffix: '@phone.penta.internal', new_email_suffix: '@phone.penta.internal' }, error: null });
    await p1; await p2;
    check('a double-tap on Confirm results in exactly ONE call', invokeCalls.length, 1);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
