// Tom reported Grokbot (his external login-driving bot) getting stuck on
// "Signing in..." forever. Diagnosis: pentaWireLoginForm's submit handler
// had NO error handling at all around PentaAuth.signIn/signInWithPhone --
// no try/catch, no timeout, no finally. If that call ever threw instead of
// cleanly returning {error}, or simply never resolved, the button stayed
// disabled on "Signing in..." forever with no way to recover. Confirmed
// live: every real sign-in attempt that night completed cleanly at the
// Supabase server (clean 200s, no lockout/rate-limit pattern in the auth
// logs) -- so the hang was 100% client-side, not a server-side rejection.
//
// Fix: race every sign-in call against an 18s timeout, wrap both the email
// and phone paths in try/catch/finally (finally always resets the button),
// and show a distinct message per failure class. Also: a global
// unhandledrejection safety net, and clearing a locally-stored session
// token on "Invalid Refresh Token" / "Session not found" (seen in that
// night's real auth logs) instead of letting a dead token keep getting
// optimistically trusted on the next page load.
//
// This file drives the REAL pentaWireLoginForm + its new helpers
// (extracted from index.html, run in a vm sandbox against a fake
// PentaAuth) with FAKE credentials only -- never anything real.
//
// Run with: node tests/login-never-hangs.test.js

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

// Covers _pentaWithTimeout, _pentaClearStaleSession, _pentaLoginErrorMessage
// and pentaWireLoginForm itself -- all declared back-to-back in this order.
const loginFormSrc = extract('function _pentaWithTimeout(promise, ms) {', '\nasync function logout()');

function makeEl(id, overrides) {
  return Object.assign({
    id: id, value: '', textContent: '', disabled: false,
    style: { display: '', color: '', background: '', borderColor: '' },
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function (evt, fn) { this['_on_' + evt] = fn; },
    required: false
  }, overrides || {});
}

function buildSandbox(authImpl) {
  const emailEl = makeEl('penta-login-email', { value: 'owner@example.invalid' });
  const pwEl = makeEl('penta-login-password', { value: 'fake-password-not-real' });
  const btn = makeEl('penta-login-submit');
  const form = makeEl('penta-login-form');
  const errEl = makeEl('penta-login-error');
  const els = {
    'penta-login-form': form,
    'penta-login-error': errEl,
    'penta-login-password': pwEl,
    'penta-login-email': emailEl,
    'penta-login-phone': makeEl('penta-login-phone'),
    'penta-login-submit': btn,
    'penta-login-email-field': makeEl('penta-login-email-field'),
    'penta-login-phone-field': makeEl('penta-login-phone-field'),
    'penta-login-mode-toggle': makeEl('penta-login-mode-toggle')
  };
  const state = { reloaded: false, removedKeys: [] };
  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: { removeItem: function (k) { state.removedKeys.push(k); } },
    document: { getElementById: function (id) { return els[id] || null; } },
    window: {
      location: { reload: function () { state.reloaded = true; } },
      PentaAuth: Object.assign({ signIn: async function () { return { error: 'not used' }; }, signInWithPhone: async function () { return { error: 'not used' }; } }, authImpl)
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(loginFormSrc, sandbox);
  sandbox.pentaWireLoginForm();
  return { sandbox, form, btn, errEl, pwEl, state };
}

async function submit(form) {
  await form._on_submit({ preventDefault: function () {} });
}

async function main() {
  // ---- A sign-in call that never resolves times out and resets the
  // button instead of hanging forever. ----
  {
    const { form, btn, errEl } = buildSandbox({ signIn: function () { return new Promise(function () {}); } });
    // Fast-forward: the real timeout is 18s: too slow for a unit test, so
    // run setTimeout callbacks immediately for just this one call.
    const real = global.setTimeout;
    global.setTimeout = function (fn) { return real(fn, 0); };
    await submit(form);
    global.setTimeout = real;
    check('a sign-in call that never resolves still re-enables the button', btn.disabled, false);
    check('the button text is reset back to "Sign in"', btn.textContent, 'Sign in');
    check('the error message explains it was a timeout', /taking too long/i.test(errEl.textContent), true);
  }

  // ---- A thrown exception (not a clean {error} result) is caught and
  // still resets the button -- this is the exact bug: previously this
  // exception was completely unhandled and the button stayed stuck. ----
  {
    const { form, btn, errEl } = buildSandbox({ signIn: async function () { throw new Error('simulated unexpected SDK exception'); } });
    await submit(form);
    check('a thrown exception still re-enables the button', btn.disabled, false);
    check('the button text is reset back to "Sign in"', btn.textContent, 'Sign in');
    check('the error message includes the underlying reason', /simulated unexpected SDK exception/.test(errEl.textContent), true);
  }

  // ---- Each error type shows its own distinct message. ----
  {
    const cases = [
      { error: 'Invalid login credentials', expect: /wrong email\/phone or password/i },
      { error: 'Too many requests, rate limit exceeded', expect: /too many attempts/i },
      { error: 'Invalid Refresh Token: Refresh Token Not Found', expect: /saved sign-in had expired/i },
      { error: 'Session not found', expect: /saved sign-in had expired/i },
      { error: 'Failed to fetch', expect: /network error/i },
      { error: 'Something unexpected happened', expect: /Couldn't sign in: Something unexpected happened/ }
    ];
    for (const c of cases) {
      const { form, errEl } = buildSandbox({ signIn: async function () { return { error: c.error }; } });
      await submit(form);
      check('error "' + c.error + '" shows its own distinct message', c.expect.test(errEl.textContent), true);
    }
  }

  // ---- "Invalid Refresh Token" / "Session not found" clear the stale
  // locally-stored session instead of leaving it to loop on the next load. ----
  {
    const { form, state } = buildSandbox({ signIn: async function () { return { error: 'Invalid Refresh Token: Refresh Token Not Found' }; } });
    await submit(form);
    check('the stale session token is removed from localStorage', state.removedKeys.indexOf('sb-wymoezilyjmyibmuqqmr-auth-token') !== -1, true);
  }

  // ---- A sign-in attempt right after a failed one still works cleanly
  // (the password field is cleared on failure, same as before this fix --
  // a real user retypes it). ----
  {
    let calls = 0;
    const { form, pwEl, state } = buildSandbox({
      signIn: async function () {
        calls++;
        return calls === 1 ? { error: 'Invalid login credentials' } : { ok: true };
      }
    });
    await submit(form);
    check('the password field is cleared after a failed attempt', pwEl.value, '');
    pwEl.value = 'retyped-fake-password';
    await submit(form);
    check('the retry actually calls signIn again', calls, 2);
    check('a successful retry reloads the page', state.reloaded, true);
  }

  // ---- The phone-login path gets the same timeout + try/catch/finally
  // treatment as the email path. ----
  {
    const emailEl = makeEl('penta-login-email');
    const pwEl = makeEl('penta-login-password', { value: 'fake-password-not-real' });
    const phEl = makeEl('penta-login-phone', { value: '+15555550123' });
    const btn = makeEl('penta-login-submit');
    const form = makeEl('penta-login-form');
    const errEl = makeEl('penta-login-error');
    const modeToggle = makeEl('penta-login-mode-toggle');
    const emailField = makeEl('penta-login-email-field');
    const phoneField = makeEl('penta-login-phone-field');
    const els = {
      'penta-login-form': form, 'penta-login-error': errEl, 'penta-login-password': pwEl,
      'penta-login-email': emailEl, 'penta-login-phone': phEl, 'penta-login-submit': btn,
      'penta-login-email-field': emailField, 'penta-login-phone-field': phoneField, 'penta-login-mode-toggle': modeToggle
    };
    const sandbox = {
      console, setTimeout, clearTimeout,
      localStorage: { removeItem: function () {} },
      document: { getElementById: function (id) { return els[id] || null; } },
      window: { location: { reload: function () {} }, PentaAuth: { signInWithPhone: function () { return new Promise(function () {}); }, signIn: async function () { return { error: 'not used' }; } } }
    };
    vm.createContext(sandbox);
    vm.runInContext(loginFormSrc, sandbox);
    sandbox.pentaWireLoginForm();
    modeToggle._on_click({ preventDefault: function () {} });
    const real = global.setTimeout;
    global.setTimeout = function (fn) { return real(fn, 0); };
    await submit(form);
    global.setTimeout = real;
    check('the phone-login path also resets the button after a hang', btn.disabled, false);
    check('the phone-login path also shows a timeout message', /taking too long/i.test(errEl.textContent), true);
  }

  // ---- Boot-time: an unexpected SIGNED_OUT clears the stored session
  // token too (closes the "stale token keeps getting trusted" gap). ----
  {
    const removed = [];
    const fakeClient = {
      auth: {
        _cbs: [],
        onAuthStateChange: function (cb) { this._cbs.push(cb); },
        signInWithPassword: async function () { return { data: { session: null }, error: null }; },
        getSession: async function () { return { data: { session: null } }; }
      }
    };
    const sandbox = {
      console, setTimeout, clearTimeout,
      localStorage: { removeItem: function (k) { removed.push(k); } },
      window: { supabase: { createClient: function () { return fakeClient; } } }
    };
    vm.createContext(sandbox);
    // The whole thing is a self-contained IIFE (declares its own
    // PROJECT_URL/PUBLISHABLE_KEY/waitForSDK) -- extract it whole.
    const authSrc = extract('(function(){\n  var PROJECT_URL', '\n</script>');
    vm.runInContext(authSrc, sandbox);
    fakeClient.auth._cbs.forEach(function (cb) { cb('SIGNED_OUT'); });
    check('an unexpected SIGNED_OUT clears the stored session token', removed.indexOf('sb-wymoezilyjmyibmuqqmr-auth-token') !== -1, true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
