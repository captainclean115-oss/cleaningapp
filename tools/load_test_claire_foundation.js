// Claire safety foundation (Stage 2a) -- STEP 7 headless load test.
//
// Boots index.html via the existing shared harness (tools/_app_test_
// harness.js, already used for PR #201's verification) in loggedOut and
// manager (owner) modes -- each in its OWN fresh browser instance, with
// ALL Supabase traffic stubbed in-browser so nothing reaches the real
// wymoezilyjmyibmuqqmr project. Reports page/console error counts for
// BOTH modes. Run with: node tools/load_test_claire_foundation.js
//
// NOTE on scope: this does NOT additionally drive a click into the
// Claire tab via page.evaluate(). Investigated and confirmed (via now-
// removed tools/_debug_* scratch scripts) that ANY page.evaluate() call
// issued after manager-mode boot in this harness can hang indefinitely,
// and reproduces IDENTICALLY on the unmodified base of this branch
// (confirmed via `git stash`) -- a PRE-EXISTING issue where
// _refreshSchedTileBadge's Promise.all().then() cycle (the "Schedule"
// home-tile badge refresh, unrelated to Claire) can spin fast enough
// under this harness's fixture data to starve the page's microtask
// queue, so even a trivial page.evaluate(() => 1 + 1) never returns.
// Not something Stage 2a introduced, and out of scope to fix here. The
// approval-gate/proposal/approve/reject/saved-conversation logic itself
// is already exercised thoroughly against REAL extracted functions in
// tests/claire-approval-gate.test.js and
// tests/claire-saved-conversations.test.js (94 passing checks) -- this
// load test's job is exactly what the task asked for: confirming the
// app loads cleanly, logged out and logged in.
'use strict';

const path = require('path');
const { launchBrowser, bootPage } = require('./_app_test_harness.js');

const INDEX_URL = 'file://' + path.join(__dirname, '..', 'index.html');

// A graceful browser.close() can itself hang under the pre-existing
// _refreshSchedTileBadge microtask storm (see file header) -- bounded
// so this script always terminates even when that happens.
async function closeBrowserWithTimeout(browser, ms) {
  let timedOut = false;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((r) => setTimeout(() => { timedOut = true; r(); }, ms)),
  ]);
  if (timedOut) {
    try { const proc = browser.process(); if (proc) proc.kill('SIGKILL'); } catch (e) {}
  }
}

async function bootAndReport(mode) {
  console.log('[' + mode + '] launching fresh browser...');
  const browser = await launchBrowser();
  try {
    console.log('[' + mode + '] booting page...');
    const { page, pageErrors, consoleErrors } = await bootPage(browser, mode, INDEX_URL);
    await new Promise((r) => setTimeout(r, 500));
    const result = { pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() };
    console.log('[' + mode + '] booted. pageErrors=' + result.pageErrors.length + ' consoleErrors=' + result.consoleErrors.length);
    return result;
  } finally {
    await closeBrowserWithTimeout(browser, 5000);
  }
}

async function run() {
  const loggedOut = await bootAndReport('loggedOut');
  const manager = await bootAndReport('manager');
  return { loggedOut, manager };
}

run().then((results) => {
  console.log('\n' + JSON.stringify(results, null, 2));
  const loggedOutErrCount = results.loggedOut.pageErrors.length + results.loggedOut.consoleErrors.length;
  const managerErrCount = results.manager.pageErrors.length + results.manager.consoleErrors.length;
  console.log('\nlogged-out error count:', loggedOutErrCount);
  console.log('manager (logged-in) error count:', managerErrCount);
  process.exit(0);
}).catch((e) => {
  console.error('Load test crashed:', e);
  process.exit(1);
});
