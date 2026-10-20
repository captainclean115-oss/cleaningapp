'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const { launchBrowser, bootPage } = require('./_app_test_harness');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

function startStaticServer() {
  const html = fs.readFileSync(INDEX_HTML_PATH);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function printErrors(label, pageErrors, consoleErrors) {
  console.log('\n=== ' + label + ' ===');
  console.log('uncaught JS exceptions: ' + pageErrors.length);
  pageErrors.forEach((e, i) => console.log('  [pageerror ' + i + '] ' + e.split('\n')[0]));
  console.log('console.error calls: ' + consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log('  [console.error ' + i + '] ' + e));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT after ' + ms + 'ms: ' + label)), ms)),
  ]);
}

async function snapshotAction(page, pageErrors, consoleErrors, label, fn) {
  const p0 = pageErrors.length, c0 = consoleErrors.length;
  let threw = null;
  try {
    await withTimeout(fn(), 25000, label);
  } catch (e) {
    threw = e.message || String(e);
  }
  await new Promise((r) => setTimeout(r, 800));
  const newPageErrors = pageErrors.slice(p0);
  const newConsoleErrors = consoleErrors.slice(c0);
  const status = (newPageErrors.length === 0 && !threw) ? 'PASS' : 'FAIL';
  console.log('\n--- ' + label + ' : ' + status + ' ---');
  if (threw) console.log('  evaluate() threw: ' + threw);
  newPageErrors.forEach((e) => console.log('  [new pageerror] ' + e.split('\n')[0]));
  if (newConsoleErrors.length) newConsoleErrors.forEach((e) => console.log('  [new console.error] ' + e));
  return { status, newPageErrors, newConsoleErrors, threw };
}

(async () => {
  const server = await startStaticServer();
  const INDEX_URL = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await launchBrowser();
  const results = {};

  // ===================== TASK 1: three boot states =====================
  for (const mode of ['loggedOut', 'manager', 'employee']) {
    const { page, pageErrors, consoleErrors } = await withTimeout(bootPage(browser, mode, INDEX_URL), 70000, 'bootPage(' + mode + ')');
    printErrors('TASK 1 boot state: ' + mode, pageErrors, consoleErrors);
    results['boot_' + mode] = { pageErrors: pageErrors.slice(), consoleErrors: consoleErrors.slice() };
    await page.close();
  }

  // ===================== TASK 2: specific screens =====================
  const todayStr = new Date().toISOString().slice(0, 10);

  // --- logged-out screens ---
  {
    const { page, pageErrors, consoleErrors } = await withTimeout(bootPage(browser, 'loggedOut', INDEX_URL), 70000, "bootPage(loggedOut)");
    results.login_phone_toggle = await snapshotAction(page, pageErrors, consoleErrors, 'Login screen: Sign in with phone number instead', async () => {
      await page.evaluate(() => {
        if (typeof window.pentaTogglePhoneLoginMode === 'function') { window.pentaTogglePhoneLoginMode(); return; }
        const links = Array.from(document.querySelectorAll('a,button,span,div'));
        const el = links.find((e) => (e.textContent || '').trim() === 'Sign in with phone number instead');
        if (el) el.click();
        else throw new Error('could not find "Sign in with phone number instead" element');
      });
    });
    results.forgot_password_flow = await snapshotAction(page, pageErrors, consoleErrors, 'Forgot password flow (phone mode)', async () => {
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a,button,span,div'));
        const el = els.find((e) => (e.textContent || '').trim() === 'Forgot password?');
        if (el) el.click();
        else throw new Error('could not find "Forgot password?" element');
      });
    });
    await page.close();
  }

  // --- manager screens ---
  {
    const { page, pageErrors, consoleErrors } = await withTimeout(bootPage(browser, 'manager', INDEX_URL), 70000, "bootPage(manager)");

    results.staff_screen = await snapshotAction(page, pageErrors, consoleErrors, 'Staff screen (showStaffView)', async () => {
      await page.evaluate(() => { window.showTab('clients'); });
      await new Promise((r) => setTimeout(r, 300));
      await page.evaluate(async () => { if (typeof window.showStaffView === 'function') await window.showStaffView(); else throw new Error('showStaffView is not defined'); });
    });

    results.employee_edit_modal = await snapshotAction(page, pageErrors, consoleErrors, 'Employee edit modal (openStaffProfile(0,"edit"))', async () => {
      await page.evaluate(() => {
        if (typeof window.openStaffProfile !== 'function') throw new Error('openStaffProfile is not defined');
        window.openStaffProfile(0, 'edit');
      });
    });

    results.send_invite_button = await snapshotAction(page, pageErrors, consoleErrors, 'Send Invite button (stubbed send-invite call)', async () => {
      await page.evaluate(async () => {
        const btn = document.querySelector('[data-action="send-invite"]');
        if (!btn) throw new Error('no [data-action="send-invite"] button found in the edit modal');
        btn.click();
      });
    });

    results.bulk_invite_modal = await snapshotAction(page, pageErrors, consoleErrors, 'Bulk invites modal (openBulkInviteModal)', async () => {
      await page.evaluate(() => {
        if (typeof window.openBulkInviteModal !== 'function') throw new Error('openBulkInviteModal is not defined');
        window.openBulkInviteModal();
      });
    });

    results.messages_new_text = await snapshotAction(page, pageErrors, consoleErrors, 'Messages screen + New text box', async () => {
      await page.evaluate(() => { window.showTab('messages'); });
      await new Promise((r) => setTimeout(r, 300));
      await page.evaluate(() => {
        if (typeof window.openNewTextComposer !== 'function') throw new Error('openNewTextComposer is not defined');
        window.openNewTextComposer();
      });
    });

    results.teams_modal = await snapshotAction(page, pageErrors, consoleErrors, 'Teams modal (openTeamManager)', async (dateStr) => {
      await page.evaluate(async (d) => {
        if (typeof window.openTeamManager !== 'function') throw new Error('openTeamManager is not defined');
        await window.openTeamManager(d);
      }, todayStr);
    });

    await page.close();
  }

  // --- employee portal screens ---
  {
    const { page, pageErrors, consoleErrors } = await withTimeout(bootPage(browser, 'employee', INDEX_URL), 70000, "bootPage(employee)");
    results.hours_tab = await snapshotAction(page, pageErrors, consoleErrors, 'Employee portal Hours tab (showPortalTab)', async () => {
      await page.evaluate(() => {
        if (typeof window.showPortalTab === 'function') { window.showPortalTab('hours'); return; }
        if (typeof window.openEmployeeHours === 'function') { window.openEmployeeHours(); return; }
        throw new Error('neither showPortalTab nor openEmployeeHours is defined');
      });
    });
    await page.close();
  }

  await browser.close();
  server.close();

  console.log('\n\n============ SUMMARY ============');
  for (const [k, v] of Object.entries(results)) {
    if (v && v.status) console.log(k + ': ' + v.status);
  }
})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
