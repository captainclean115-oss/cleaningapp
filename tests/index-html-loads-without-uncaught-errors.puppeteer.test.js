// Regression test for the pentaShowInviteSendModal outage (2026-10-20):
// that function was deleted during the server-side invites rewrite, but
// one `window.pentaShowInviteSendModal = pentaShowInviteSendModal;`
// export line was left behind. It ran at top-level IIFE execution time
// on every single page load, so the resulting ReferenceError crashed
// the rest of that <script> block before `jobs`/`dailyAssignments`
// could be declared -- the live site rendered almost nothing (just the
// bare "SORT:" label, no options, no app). node --check and the vm-
// sandbox tests in this directory both missed it, because the broken
// line was syntactically valid JS (a plain identifier reference) --
// only a REAL browser, actually executing the page top to bottom, can
// catch a ReferenceError like this.
//
// This test loads the real index.html in a real (headless) browser and
// fails if ANY uncaught JS exception fires during startup. It does not
// log in or exercise any feature -- it only proves the page's own
// top-level script execution completes cleanly, which is exactly the
// class of bug that broke production here.
//
// Requires: Chrome installed locally (puppeteer-core, no bundled
// Chromium download). Run with:
//   node tests/index-html-loads-without-uncaught-errors.puppeteer.test.js

const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome() {
  const fs = require('fs');
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

(async () => {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('SKIP: no local Chrome/Chromium found at ' + CHROME_CANDIDATES.join(' or ') + ' -- cannot run a real-browser startup check here.');
    process.exit(0);
  }

  const indexPath = path.join(__dirname, '..', 'index.html');
  const fileUrl = 'file://' + indexPath;

  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.stack || err.message || String(err));
  });

  let navError = null;
  try {
    await page.goto(fileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    navError = e.message;
  }
  // A couple seconds for any deferred/async top-level init to settle.
  await new Promise((r) => setTimeout(r, 2000));

  console.log('Testing index.html loads cleanly in a real browser (' + fileUrl + ')\n');

  check('page navigation itself did not error', navError, null);
  check(
    'zero uncaught JS exceptions fired during startup' + (pageErrors.length ? ':\n    ' + pageErrors.join('\n    ') : ''),
    pageErrors.length,
    0
  );

  // Sanity check that the page actually got far enough to render real
  // content, not just an early-blank document -- the sort-dropdown
  // options are built by code that runs AFTER the exact point this bug
  // used to crash, so their presence is itself evidence startup
  // completed, not just a guess at an unrelated element.
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
  check('the sort-dropdown options rendered (proves startup script ran past the historical crash point)', /Last name A.*?Z/.test(bodyText), true);

  await browser.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
