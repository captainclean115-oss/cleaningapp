// Regression test for the pentaShowInviteSendModal outage (2026-10-20):
// PR #199's server-side-invites rewrite deleted that function, but left
// behind one `window.pentaShowInviteSendModal = pentaShowInviteSendModal;`
// export line. It ran at top-level IIFE execution time on EVERY page
// load, so the resulting ReferenceError crashed the rest of that
// <script> block before `jobs`/`dailyAssignments` could be declared --
// the live site rendered almost nothing (bare "SORT:" label, no app).
// node --check and the vm-sandbox tests elsewhere in this directory
// both missed it, because the broken line was syntactically valid JS --
// only a REAL browser, actually executing the page top to bottom,
// catches a ReferenceError like this.
//
// This file loads the real index.html in a real (headless) browser and
// fails if ANY uncaught JS exception fires -- in all three session
// states a real visitor can land in (logged out, manager, employee
// portal), plus two quick logged-out-screen interactions. The Supabase
// backend (REST, Auth, Edge Functions) is fully intercepted and stubbed
// by ./_app_test_harness.js (shared with tools/_verify_pr201.js) -- this
// test makes zero real network calls and touches no real database.
//
// Scope note: this deliberately does NOT drive through the deeper
// MANAGER-only screens (Staff screen, Send Invite, Bulk invite, Teams
// modal, Messages composer). The employee portal's own Hours tab IS
// covered live below (employee portal polish, 2026-10-22) -- it turned
// out NOT to hit the same latency wall the manager screens do, since it
// doesn't depend on the manager-side multi-cache chain described below.
// The manager-only screens above were checked manually during PR #201's
// review (tools/_verify_pr201.js is kept in the repo for that) but
// turned out to be unreliable to
// automate under a forged/stubbed session: this app resolves
// business_id through five independent singleton caches (PentaJobs,
// PentaAssignments, PentaRewards, PentaTeams, PentaEmployees), each with
// its own multi-second timeout chain, and under a real login they share
// one warm result almost instantly -- under a stub session with no real
// backend, they compound into tens of seconds of legitimate (not
// erroneous) retrying, past the point where a fast, reliable automated
// test is practical. Baking that into this suite would make it slow and
// flaky without actually proving more about this specific regression.
// Real device testing remains the authoritative check for those screens
// (see the PR's own test-steps section).
//
// Employee portal polish (2026-10-22): the EMPLOYEE session's own
// screens (Coming-soon tabs, the hamburger menu, Account, About me,
// Language) don't depend on the manager-side multi-cache chain above,
// so they ARE driven here -- this is the explicit "don't skip the
// check" requirement from that PR (the pentaShowInviteSendModal outage
// came from a check that was skipped).
//
// Requires: Chrome installed locally (puppeteer-core, no bundled
// Chromium download). Run with:
//   node tests/index-html-loads-without-uncaught-errors.puppeteer.test.js

const path = require('path');
const fs = require('fs');
const http = require('http');
const { findChrome, launchBrowser, bootPage } = require('../tools/_app_test_harness');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT after ' + ms + 'ms: ' + label)), ms)),
  ]);
}

function startStaticServer(indexHtmlPath) {
  const html = fs.readFileSync(indexHtmlPath);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A missing/renamed/deleted function here must FAIL the test, not skip
// it quietly -- that silent-skip is exactly how the orphaned-export bug
// would have gone undetected by a less careful check.
async function runAction(page, pageErrors, label, fn) {
  const p0 = pageErrors.length;
  let threw = null;
  try {
    await withTimeout(fn(), 10000, label);
  } catch (e) {
    threw = e.message || String(e);
  }
  await new Promise((r) => setTimeout(r, 500));
  const newPageErrors = pageErrors.slice(p0);
  check(label, { threw, newPageErrors }, { threw: null, newPageErrors: [] });
}

(async () => {
  if (!findChrome()) {
    console.log('SKIP: no local Chrome/Chromium found -- cannot run a real-browser startup check here.');
    process.exit(0);
  }

  const indexHtmlPath = path.join(__dirname, '..', 'index.html');
  const server = await startStaticServer(indexHtmlPath);
  const indexUrl = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await launchBrowser();

  console.log('Testing index.html loads cleanly in a real browser, in all three session states\n');

  try {
    for (const mode of ['loggedOut', 'manager', 'employee']) {
      const { page, pageErrors } = await bootPage(browser, mode, indexUrl);
      check('boot (' + mode + '): zero uncaught JS exceptions' + (pageErrors.length ? ':\n    ' + pageErrors.map((e) => e.split('\n')[0]).join('\n    ') : ''), pageErrors.length, 0);

      if (mode === 'loggedOut') {
        await runAction(page, pageErrors, 'loggedOut: "Sign in with phone number instead" toggle', async () => {
          await page.evaluate(() => {
            if (typeof window.pentaTogglePhoneLoginMode === 'function') { window.pentaTogglePhoneLoginMode(); return; }
            const els = Array.from(document.querySelectorAll('a,button,span,div'));
            const el = els.find((e) => (e.textContent || '').trim() === 'Sign in with phone number instead');
            if (!el) throw new Error('could not find "Sign in with phone number instead" element');
            el.click();
          });
        });

        await runAction(page, pageErrors, 'loggedOut: "Forgot password?" flow', async () => {
          await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('a,button,span,div'));
            const el = els.find((e) => (e.textContent || '').trim() === 'Forgot password?');
            if (!el) throw new Error('could not find "Forgot password?" element');
            el.click();
          });
        });
      }

      if (mode === 'employee') {
        await runAction(page, pageErrors, 'employee: Schedule tab shows Coming soon (no crash, no data fetch)', async () => {
          await page.evaluate(() => {
            if (typeof window.openEmployeeSchedule !== 'function') throw new Error('openEmployeeSchedule is not defined');
            window.openEmployeeSchedule();
          });
        });
        await runAction(page, pageErrors, 'employee: Forms tab shows Coming soon (no crash, no data fetch)', async () => {
          await page.evaluate(() => {
            if (typeof window.openEmployeeForms !== 'function') throw new Error('openEmployeeForms is not defined');
            window.openEmployeeForms();
          });
        });
        await runAction(page, pageErrors, 'employee: Hours tab still opens normally (unaffected by the gate)', async () => {
          await page.evaluate(() => {
            if (typeof window.openEmployeeHours !== 'function') throw new Error('openEmployeeHours is not defined');
            window.openEmployeeHours();
          });
        });
        await runAction(page, pageErrors, 'employee: hamburger menu opens', async () => {
          await page.evaluate(() => {
            if (typeof window.openPortalMenu !== 'function') throw new Error('openPortalMenu is not defined');
            window.openPortalMenu();
          });
        });
        await runAction(page, pageErrors, 'employee: Account screen opens from the menu', async () => {
          await page.evaluate(async () => {
            if (typeof window.openPortalAccount !== 'function') throw new Error('openPortalAccount is not defined');
            await window.openPortalAccount();
          });
        });
        await runAction(page, pageErrors, 'employee: closing Account and opening About me', async () => {
          await page.evaluate(async () => {
            if (typeof window.closePortalAccount === 'function') window.closePortalAccount();
            if (typeof window.openPortalAboutMe !== 'function') throw new Error('openPortalAboutMe is not defined');
            await window.openPortalAboutMe();
          });
        });
        await runAction(page, pageErrors, 'employee: closing About me and opening Language', async () => {
          await page.evaluate(() => {
            if (typeof window.closePortalAboutMe === 'function') window.closePortalAboutMe();
            if (typeof window.openPortalLanguage !== 'function') throw new Error('openPortalLanguage is not defined');
            window.openPortalLanguage();
          });
        });
        await runAction(page, pageErrors, 'employee: choosing Spanish applies everywhere and does not crash', async () => {
          await page.evaluate(() => {
            if (typeof window.choosePortalLanguage !== 'function') throw new Error('choosePortalLanguage is not defined');
            window.choosePortalLanguage('es');
          });
        });
        await runAction(page, pageErrors, 'employee: Log out confirmation can be dismissed without logging out', async () => {
          await page.evaluate(() => {
            const originalConfirm = window.confirm;
            window.confirm = () => false; // decline -- must NOT actually log out
            try {
              if (typeof window.portalMenuLogout !== 'function') throw new Error('portalMenuLogout is not defined');
              window.portalMenuLogout();
            } finally {
              window.confirm = originalConfirm;
            }
          });
        });
      }

      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS CRASH:', e);
  process.exit(1);
});
