// PR #154 -- "Text Application Link" button, added next to the existing
// "+ New Application (in-person)" button in the Staff > Applications tab.
// Reuses the existing _sendSMS() helper (native-vs-RingCentral branching,
// rate-limit/error surfacing already handled there) and the already-
// rendered #apply-share-url share link (read fresh at send time, same
// source the existing Copy button uses -- not a captured closure
// variable, so it can't go stale).
//
// Extracts and runs the ACTUAL _sendApplicationLinkSms() from index.html.
//
// Run with: node tests/text-application-link.test.js

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

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// --- Structural: the button only renders when a share URL exists ---
const headerBlock = extract('const headerHtml =\n      shareRow +', "'</div>';\n    if (!data || data.length === 0) {", 'headerHtml');
check('the Text Application Link button is gated on _shareUrl being truthy (no dead-link send when the tenant has no slug configured)', /_shareUrl \? '<button onclick="openTextApplicationLinkModal\(\)"/.test(headerBlock), true);
check('the in-person button always renders regardless of _shareUrl', /openManagerApplication\(\)/.test(headerBlock), true);

// --- Behavioral: _sendApplicationLinkSms() ---
const fnSource = extract('async function _sendApplicationLinkSms() {', '\n\nfunction renderStaffList() {', '_sendApplicationLinkSms');

function buildSandbox({ phoneValue, shareUrlValue, sendSmsImpl, tenantName }) {
  const elements = {
    'text-app-link-error': { style: {}, textContent: '' },
    'text-app-link-send-btn': { disabled: false, textContent: 'Send' },
    'text-app-link-phone': { value: phoneValue },
    'apply-share-url': shareUrlValue == null ? null : { value: shareUrlValue },
    'text-app-link-overlay': { remove: () => {} },
  };
  const sandbox = {
    console,
    document: { getElementById: (id) => (id in elements ? elements[id] : null) },
    window: { PentaTenant: { name: () => tenantName || '' } },
    showToast: () => {},
    _sendSMS: sendSmsImpl,
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox, elements };
}

(async () => {
  async function run(phoneValue, shareUrlValue, sendSmsImpl, tenantName) {
    const { sandbox, elements } = buildSandbox({ phoneValue, shareUrlValue, sendSmsImpl, tenantName });
    await sandbox._sendApplicationLinkSms();
    return elements;
  }

  {
    let called = false;
    const elements = await run('123', 'https://app.example.com/?biz=manna', () => { called = true; return Promise.resolve({ ok: true }); });
    check('a too-short number is rejected with an error, _sendSMS never called', called, false);
    check('the error message explains what to fix', elements['text-app-link-error'].textContent.indexOf('10-digit') !== -1, true);
  }

  {
    let capturedArgs = null;
    const elements = await run('(555) 123-4567', 'https://app.example.com/?biz=manna', (phone, msg, opts) => {
      capturedArgs = [phone, msg, opts];
      return Promise.resolve({ ok: true });
    }, 'Manna Maids');
    check('a formatted 10-digit US number is converted to +1 E.164 before sending', capturedArgs[0], '+15551234567');
    check('the message includes the real share URL, not a placeholder', capturedArgs[1].indexOf('https://app.example.com/?biz=manna') !== -1, true);
    check('the message includes the business name', capturedArgs[1].indexOf('Manna Maids') !== -1, true);
    check('allowUnknown is passed -- an arbitrary phone number is a legitimate unknown-recipient case', capturedArgs[2], { allowUnknown: true });
    check('on success, the overlay is dismissed (no lingering modal)', typeof elements['text-app-link-overlay'].remove, 'function');
  }

  {
    // A number with a leading country code "1" (11 digits) is also accepted.
    let capturedArgs = null;
    await run('1-555-123-4567', 'https://app.example.com/?biz=manna', (phone, msg, opts) => {
      capturedArgs = [phone, msg, opts];
      return Promise.resolve({ ok: true });
    });
    check('an 11-digit number with a leading 1 is normalized the same way as a bare 10-digit number', capturedArgs[0], '+15551234567');
  }

  {
    // No share URL available (e.g. tenant has no slug configured yet) -- must not call _sendSMS with an empty link.
    let called = false;
    const elements = await run('5551234567', '', () => { called = true; return Promise.resolve({ ok: true }); });
    check('sending is blocked when there is no share URL to send (not a silent empty-link text)', called, false);
    check('a clear error explains why', elements['text-app-link-error'].textContent.indexOf('No application link') !== -1, true);
  }

  {
    // _sendSMS throwing (e.g. rate limit) surfaces its message, doesn't crash or silently succeed.
    const elements = await run('5551234567', 'https://app.example.com/?biz=manna', () => Promise.reject(new Error('Rate limit reached — try again in a few minutes')));
    check('a thrown _sendSMS error is surfaced to the user, not swallowed', elements['text-app-link-error'].textContent, 'Rate limit reached — try again in a few minutes');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
