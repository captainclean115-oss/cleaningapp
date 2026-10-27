// Server-side invites feature -- extracts and runs the ACTUAL
// pentaSendInvite() (plus its guard state and helpers) from index.html.
// Covers the double-click guard, the 60-second resend guard, and that a
// server failure shows a visible red message with a Copy invite link
// fallback instead of silently doing nothing.
//
// Run with: node tests/pentasendinvite-guards.test.js

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

const inviteSrc = extract(
  'var _inviteInFlight = {};',
  '\n\n  function _randomPassword() {',
  'pentaSendInvite + guards'
);
const extractInviteErrorSrc = extract(
  '// Invite-collision guard: shared by both the single-invite',
  '\n\n// =====================================================================',
  '_extractInviteError helper'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const invokeCalls = [];
  const nodes = {};
  function el(selector) {
    if (!nodes[selector]) nodes[selector] = { innerHTML: '' };
    return nodes[selector];
  }
  const sandbox = {
    console,
    CSS: { escape: function (s) { return s; } },
    document: {
      querySelector: function (sel) { return el(sel); },
    },
    _adminEsc: function (s) { return String(s); },
    _resolveEmployeeByRoster: function () {
      return Promise.resolve(opts.resolved || { error: null, employee: { id: 'emp-uuid-1', first_name: 'Elvia', phone: '7816263485', business_id: 'biz-1' } });
    },
    window: {
      PentaEmployees: { listSync: function () { return []; } },
      supabaseClient: {
        functions: {
          invoke: function (name, args) {
            invokeCalls.push({ name: name, args: args });
            if (opts.invokeImpl) return opts.invokeImpl(name, args);
            return Promise.resolve({ data: { success: true }, error: null });
          },
        },
      },
    },
    supabaseClient: null, // set below to mirror window.supabaseClient
  };
  sandbox.supabaseClient = sandbox.window.supabaseClient;
  vm.createContext(sandbox);
  vm.runInContext(extractInviteErrorSrc, sandbox);
  vm.runInContext(inviteSrc, sandbox);
  return { sandbox: sandbox, invokeCalls: invokeCalls, nodes: nodes };
}

(async function () {
  console.log('Testing extracted pentaSendInvite() guards from index.html\n');

  // ---- Double-click guard: a second call while the first is still
  // in-flight must be a no-op (no second invoke call). ----
  {
    let resolveFirst;
    const { sandbox, invokeCalls } = buildSandbox({
      invokeImpl: function () { return new Promise(function (r) { resolveFirst = r; }); },
    });
    const p1 = sandbox.pentaSendInvite('roster-1');
    const p2 = sandbox.pentaSendInvite('roster-1'); // fired before p1 resolves -- simulates a double-click
    // Let the microtask queue drain enough for p1 to actually reach its
    // sb.functions.invoke() call (it awaits _resolveEmployeeByRoster
    // first) before resolving it -- a few ticks, not a real timer.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    resolveFirst({ data: { success: true }, error: null });
    await p1; await p2;
    check('a double-click while the first send is in flight results in exactly ONE invoke call', invokeCalls.length, 1);
  }

  // ---- 60-second resend guard: a second REAL send right after a
  // successful one is blocked with a visible wait message, no new
  // invoke call. ----
  {
    const { sandbox, invokeCalls, nodes } = buildSandbox({});
    await sandbox.pentaSendInvite('roster-2');
    check('first send succeeds (one invoke call)', invokeCalls.length, 1);
    await sandbox.pentaSendInvite('roster-2'); // immediately again
    check('an immediate resend makes NO second invoke call', invokeCalls.length, 1);
    const resultHtml = nodes['[id="invite-send-result"][data-roster-id="roster-2"]'].innerHTML;
    check('the resend block shows a visible wait message', /Please wait/.test(resultHtml), true);
  }

  // ---- A server-reported failure shows a visible red message AND a
  // Copy invite link fallback button -- never silent, never just logs. ----
  {
    const { sandbox, nodes } = buildSandbox({
      invokeImpl: function () { return Promise.resolve({ data: { success: false, error: 'Could not send the text. Try again.' }, error: null }); },
    });
    await sandbox.pentaSendInvite('roster-3');
    const resultHtml = nodes['[id="invite-send-result"][data-roster-id="roster-3"]'].innerHTML;
    check('a reported failure shows the server\'s own plain-English reason', /Could not send the text/.test(resultHtml), true);
    check('a reported failure shows the Copy invite link fallback button', /Copy invite link/.test(resultHtml), true);
  }

  // ---- A network-level throw (invoke itself rejects) also shows a
  // visible message + fallback, never an unhandled rejection. ----
  {
    const { sandbox, nodes } = buildSandbox({
      invokeImpl: function () { return Promise.reject(new Error('fetch failed')); },
    });
    await sandbox.pentaSendInvite('roster-4');
    const resultHtml = nodes['[id="invite-send-result"][data-roster-id="roster-4"]'].innerHTML;
    check('a thrown/network error shows a visible message', /could not reach the server/i.test(resultHtml), true);
    check('a thrown/network error also shows the Copy invite link fallback', /Copy invite link/.test(resultHtml), true);
  }

  // ---- A successful send shows a masked phone number and a time, never the full number or nothing. ----
  {
    const { sandbox, nodes } = buildSandbox({});
    await sandbox.pentaSendInvite('roster-5');
    const resultHtml = nodes['[id="invite-send-result"][data-roster-id="roster-5"]'].innerHTML;
    check('success shows a masked phone (last 4 digits only)', /\*\*\*-\*\*\*-3485/.test(resultHtml), true);
    check('success never shows the Copy invite link button (nothing failed)', /Copy invite link/.test(resultHtml), false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
