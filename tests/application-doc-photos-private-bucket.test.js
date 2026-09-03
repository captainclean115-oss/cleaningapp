// PR #156 -- application document photos (license/passport/SSN) never
// displayed for a manager viewing an application, even for a genuinely
// successful upload.
//
// Diagnosed: the 'applications' storage bucket is private (public: false)
// -- correctly, since these are SSN cards, driver's licenses, passports.
// But the submit-side code called getPublicUrl(), which always produces
// a URL that 400s for a private bucket, and openApplicantDetail() then
// rendered that broken URL as a plain <a href> link. Confirmed live:
// real uploads succeeded in Supabase Storage back in April (proving the
// bucket/RLS/upload mechanism itself is fine), but every stored
// *_url column value was a getPublicUrl() result that was never actually
// viewable.
//
// Fix follows the same convention already used elsewhere for a private
// bucket (PentaEmployees.getSignedPhotoUrl, employee-photos): store the
// bucket-relative PATH, not a URL, and generate a signed URL on demand
// at view time. _appDocStoragePath() normalizes both the new (bare path)
// and pre-existing (full getPublicUrl string) stored formats so old rows
// don't break.
//
// Also: a document the applicant actually selected that failed to upload
// used to fail 100% silently (console.error only, application still
// submitted "successfully" with that field blank). Now surfaced via
// app-error -- doesn't block submission (these documents are genuinely
// optional per the original Sprint 4.2.B design), just makes a real
// failure visible instead of invisible.
//
// Run with: node tests/application-doc-photos-private-bucket.test.js

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

// --- _appDocStoragePath: normalizes old and new stored formats ---
const pathFn = extract('function _appDocStoragePath(value) {', '\n}\n', '_appDocStoragePath') + '\n}\n';
{
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(pathFn, sandbox);

  check('null/empty value returns null', sandbox._appDocStoragePath(null), null);
  check(
    'a pre-#156 getPublicUrl() string is reduced to the bare bucket-relative path',
    sandbox._appDocStoragePath('https://wymoezilyjmyibmuqqmr.supabase.co/storage/v1/object/public/applications/biz-1/app-1/driver_license_front_url.png'),
    'biz-1/app-1/driver_license_front_url.png'
  );
  check(
    'a signed-URL-shaped string (with a query string) is also reduced to the bare path',
    sandbox._appDocStoragePath('https://x.supabase.co/storage/v1/object/sign/applications/biz-1/app-1/passport_url.jpg?token=abc123'),
    'biz-1/app-1/passport_url.jpg'
  );
  check(
    'a post-#156 bare path (no http prefix) passes through unchanged',
    sandbox._appDocStoragePath('biz-1/app-1/ssn_card_url.png'),
    'biz-1/app-1/ssn_card_url.png'
  );
}

// --- Submit-side: the doc upload loop stores a raw path, not getPublicUrl(), and collects failures ---
const submitFnFull = extract('async function submitApplication() {', '\n\nasync function ', 'submitApplication');
check('the upload loop no longer calls .getPublicUrl() (broken for a private bucket)', submitFnFull.indexOf('.getPublicUrl(') === -1, true);
check('a successful upload stores the raw path directly', submitFnFull.indexOf('docUrls[d.col] = path;') !== -1, true);
check('a failed upload (selected file, upload errored) is pushed to docUploadFailures, not just console.error\'d', /docUploadFailures\.push\(d\.label\)/.test(submitFnFull), true);
check('upload failures are surfaced via app-error (visible), not silent', submitFnFull.indexOf("could not be uploaded") !== -1, true);

// --- View-side: openApplicantDetail generates signed URLs, distinguishes "none uploaded" from "failed to load" ---
const detailFn = extract('async function openApplicantDetail(id) {', '\n\nasync function ', 'openApplicantDetail');

function buildDetailSandbox({ appRow, signedUrlImpl }) {
  const els = {};
  const sandbox = {
    console,
    window: {
      supabaseClient: {
        from: (table) => ({
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: appRow, error: null }) }) }),
        }),
        storage: { from: () => ({ createSignedUrl: signedUrlImpl }) },
      },
    },
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [],
      body: { appendChild: () => {}, insertAdjacentHTML: () => {} },
    },
    _appHtmlEscape: (s) => s,
  };
  vm.createContext(sandbox);
  vm.runInContext(pathFn + '\n' + detailFn, sandbox);
  return sandbox;
}

(async () => {
  // A brand-new (post-#156) row: raw path stored, signed URL generation succeeds.
  {
    let signedPathRequested = null;
    const sandbox = buildDetailSandbox({
      appRow: { first_name: 'Test', last_name: 'App', driver_license_front_url: 'biz-1/app-1/driver_license_front_url.png', driver_license_back_url: null, passport_url: null, ssn_card_url: null },
      signedUrlImpl: (p) => { signedPathRequested = p; return Promise.resolve({ data: { signedUrl: 'https://signed.example/x?token=y' }, error: null }); },
    });
    // openApplicantDetail writes to document.body via appendChild with an
    // innerHTML string -- capture it by intercepting the div creation path
    // is more than this test needs; call the function and just confirm it
    // doesn't throw and requests the exact expected path.
    await sandbox.openApplicantDetail('app-1');
    check('a raw stored path (new format) is passed to createSignedUrl unchanged', signedPathRequested, 'biz-1/app-1/driver_license_front_url.png');
  }

  // A pre-#156 row: full getPublicUrl() string stored, still resolves correctly.
  {
    let signedPathRequested = null;
    const sandbox = buildDetailSandbox({
      appRow: { first_name: 'Old', last_name: 'Row', driver_license_front_url: 'https://x.supabase.co/storage/v1/object/public/applications/biz-1/app-2/driver_license_front_url.png', driver_license_back_url: null, passport_url: null, ssn_card_url: null },
      signedUrlImpl: (p) => { signedPathRequested = p; return Promise.resolve({ data: { signedUrl: 'https://signed.example/x?token=y' }, error: null }); },
    });
    await sandbox.openApplicantDetail('app-2');
    check('a pre-#156 stored full URL is normalized to a bare path before calling createSignedUrl', signedPathRequested, 'biz-1/app-2/driver_license_front_url.png');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
