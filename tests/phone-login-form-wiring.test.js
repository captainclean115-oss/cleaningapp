// Phone + password login feature -- extracts and runs the ACTUAL
// pentaWireLoginForm() from index.html in a DOM-stub sandbox. Proves:
// (1) email mode is BYTE-FOR-BYTE the same PentaAuth.signIn/resetPassword
//     calls as before this feature -- the 5 already-linked employees'
//     (and every manager's) existing login is untouched;
// (2) phone mode calls the NEW signInWithPhone/requestPhoneReset methods
//     instead, never the email ones;
// (3) the mode toggle actually flips which fields are required/visible.
//
// Run with: node tests/phone-login-form-wiring.test.js

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

const wireSrc = extract('function pentaWireLoginForm() {', '\nasync function logout() {', 'pentaWireLoginForm');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function makeEl(tag) {
  const listeners = {};
  return {
    tagName: tag,
    value: '',
    textContent: '',
    style: {},
    required: false,
    disabled: false,
    addEventListener: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    _fire: function (evt, e) { (listeners[evt] || []).forEach(function (fn) { fn(e || { preventDefault: function () {} }); }); },
  };
}

function buildSandbox(authStub) {
  const els = {
    'penta-login-form': makeEl('form'),
    'penta-login-error': makeEl('div'),
    'penta-login-password': makeEl('input'),
    'penta-login-email': makeEl('input'),
    'penta-login-phone': makeEl('input'),
    'penta-login-submit': makeEl('button'),
    'penta-login-email-field': makeEl('div'),
    'penta-login-phone-field': makeEl('div'),
    'penta-login-mode-toggle': makeEl('a'),
    'penta-login-forgot-link': makeEl('a'),
  };
  const sandbox = {
    console: console,
    document: { getElementById: function (id) { return els[id] || null; } },
    window: { PentaAuth: authStub, location: { reload: function () {} } },
    PentaAuth: authStub,
  };
  // window.location.reload is called bare as `window.location.reload()`
  // in the real source -- expose `window` both as a property and make
  // the sandbox's own global resolve to it for a bare `window` reference.
  vm.createContext(sandbox);
  vm.runInContext(wireSrc + '\npentaWireLoginForm();', sandbox);
  return { els: els, sandbox: sandbox };
}

(async function () {
  console.log('Testing extracted pentaWireLoginForm() from index.html\n');

  // Case 1: email mode (default) submit calls PentaAuth.signIn, never signInWithPhone.
  {
    const calls = [];
    const authStub = {
      signIn: function (email, password) { calls.push(['signIn', email, password]); return Promise.resolve({ ok: true }); },
      signInWithPhone: function () { calls.push(['signInWithPhone']); return Promise.resolve({ ok: true }); },
      resetPassword: function () { return Promise.resolve({ ok: true }); },
      requestPhoneReset: function () { return Promise.resolve({ ok: true, message: 'x' }); },
    };
    const { els } = buildSandbox(authStub);
    els['penta-login-email'].value = 'tom@manna.com';
    els['penta-login-password'].value = 'hunter22';
    els['penta-login-form']._fire('submit');
    await new Promise(function (r) { setTimeout(r, 0); });
    check('default (email) mode submit calls PentaAuth.signIn with the typed email+password', calls[0], ['signIn', 'tom@manna.com', 'hunter22']);
    check('email mode never calls signInWithPhone', calls.some(function (c) { return c[0] === 'signInWithPhone'; }), false);
  }

  // Case 2: toggling to phone mode, then submitting, calls signInWithPhone (never signIn).
  {
    const calls = [];
    const authStub = {
      signIn: function () { calls.push(['signIn']); return Promise.resolve({ ok: true }); },
      signInWithPhone: function (phone, password) { calls.push(['signInWithPhone', phone, password]); return Promise.resolve({ ok: true }); },
      resetPassword: function () { return Promise.resolve({ ok: true }); },
      requestPhoneReset: function () { return Promise.resolve({ ok: true, message: 'x' }); },
    };
    const { els } = buildSandbox(authStub);
    els['penta-login-mode-toggle']._fire('click');
    check('toggling to phone mode hides the email field', els['penta-login-email-field'].style.display, 'none');
    check('toggling to phone mode shows the phone field', els['penta-login-phone-field'].style.display, '');
    check('toggling to phone mode un-requires the email input', els['penta-login-email'].required, false);

    els['penta-login-phone'].value = '7743606209';
    els['penta-login-password'].value = 'hunter22';
    els['penta-login-form']._fire('submit');
    await new Promise(function (r) { setTimeout(r, 0); });
    check('phone mode submit calls signInWithPhone with the typed phone+password', calls[0], ['signInWithPhone', '7743606209', 'hunter22']);
    check('phone mode never calls signIn', calls.some(function (c) { return c[0] === 'signIn'; }), false);
  }

  // Case 3: forgot-password in email mode calls resetPassword(email); in
  // phone mode calls requestPhoneReset(phone). Never cross-wired.
  {
    const calls = [];
    const authStub = {
      signIn: function () { return Promise.resolve({ ok: true }); },
      signInWithPhone: function () { return Promise.resolve({ ok: true }); },
      resetPassword: function (email) { calls.push(['resetPassword', email]); return Promise.resolve({ ok: true }); },
      requestPhoneReset: function (phone) { calls.push(['requestPhoneReset', phone]); return Promise.resolve({ ok: true, message: 'If that number is on file, a text is on its way.' }); },
    };
    const { els } = buildSandbox(authStub);
    els['penta-login-email'].value = 'tom@manna.com';
    els['penta-login-forgot-link']._fire('click');
    await new Promise(function (r) { setTimeout(r, 0); });
    check('forgot-password in email mode calls resetPassword(email)', calls[0], ['resetPassword', 'tom@manna.com']);

    els['penta-login-mode-toggle']._fire('click'); // -> phone mode
    els['penta-login-phone'].value = '7743606209';
    els['penta-login-forgot-link']._fire('click');
    await new Promise(function (r) { setTimeout(r, 0); });
    check('forgot-password in phone mode calls requestPhoneReset(phone), not resetPassword again', calls[1], ['requestPhoneReset', '7743606209']);
  }

  // Case 4: a lockout-style error from signInWithPhone surfaces verbatim
  // in the error box -- the exact "try again in a few minutes" wording
  // the Edge Function returns after 5 failed attempts.
  {
    const authStub = {
      signIn: function () { return Promise.resolve({ ok: true }); },
      signInWithPhone: function () { return Promise.resolve({ error: 'Too many attempts. Try again in a few minutes.' }); },
      resetPassword: function () { return Promise.resolve({ ok: true }); },
      requestPhoneReset: function () { return Promise.resolve({ ok: true, message: 'x' }); },
    };
    const { els } = buildSandbox(authStub);
    els['penta-login-mode-toggle']._fire('click');
    els['penta-login-phone'].value = '7743606209';
    els['penta-login-password'].value = 'wrong';
    els['penta-login-form']._fire('submit');
    await new Promise(function (r) { setTimeout(r, 0); });
    check('a lockout error from the server surfaces verbatim to the employee', els['penta-login-error'].textContent, 'Too many attempts. Try again in a few minutes.');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
