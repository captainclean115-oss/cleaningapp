// Screenshots Claire's header -- minimal, tightly-bounded standalone
// boot (not the shared harness's bootPage, whose warmup step appears to
// interact badly with the pre-existing _refreshSchedTileBadge
// microtask-storm risk and can hang well past a reasonable bound).
// Every awaited step has its own timeout.
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TARGET_URL = process.argv[2] || ('file://' + path.join(__dirname, '..', 'index.html'));
const OUT_PATH = process.argv[3] || path.join(__dirname, '..', 'claire-header-screenshot.png');
const FAKE_AUTH_ID = '11111111-1111-4111-8111-111111111111';
const FAKE_BIZ_ID = '22222222-2222-4222-8222-222222222222';

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: ' + label)), ms))]);
}

function buildFakeSession() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: 'fake.manager.token', token_type: 'bearer', expires_in: 3600, expires_at: nowSec + 3600,
    refresh_token: 'fake-refresh-manager',
    user: { id: FAKE_AUTH_ID, aud: 'authenticated', email: 'fixture.manager@test.local', app_metadata: {}, user_metadata: { is_employee: false } },
  };
}

async function installInterception(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    try {
      if (url.indexOf('supabase.co') === -1) { req.continue(); return; }
      if (req.method() === 'OPTIONS') {
        req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Credentials': 'true' } });
        return;
      }
      const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true' };
      const respond = (status, body) => req.respond({ status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(body) });
      if (url.indexOf('/auth/v1/') !== -1) { respond(200, buildFakeSession()); return; }
      if (url.indexOf('/functions/v1/') !== -1) { respond(200, { success: true, ok: true }); return; }
      if (url.indexOf('/rest/v1/') !== -1) {
        const singular = (req.headers()['accept'] || '').indexOf('vnd.pgrst.object') !== -1;
        if (req.method() !== 'GET') { respond(200, singular ? {} : []); return; }
        const table = (url.match(/\/rest\/v1\/([a-zA-Z0-9_]+)/) || [])[1] || '';
        if (table === 'users') { respond(200, singular ? { role: 'owner', manager_permissions: {}, business_id: FAKE_BIZ_ID, first_name: 'Fixture', phone: null } : [{ role: 'owner', manager_permissions: {}, business_id: FAKE_BIZ_ID }]); return; }
        if (table === 'businesses') { respond(200, singular ? { name: 'Fixture Co', legal_name: 'Fixture Co LLC', timezone: 'America/New_York', pay_week_start_day: 1 } : [{ name: 'Fixture Co' }]); return; }
        respond(200, singular ? null : []);
        return;
      }
      respond(200, []);
    } catch (e) { try { req.continue(); } catch (_e2) {} }
  });
}

async function run() {
  console.log('launching...');
  const browser = await withTimeout(puppeteer.launch({ executablePath: CHROME_PATH, headless: true }), 20000, 'launch');
  try {
    const page = await withTimeout(browser.newPage(), 10000, 'newPage');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await installInterception(page);
    await page.evaluateOnNewDocument((sessionJson) => {
      try { window.localStorage.setItem('sb-wymoezilyjmyibmuqqmr-auth-token', sessionJson); } catch (e) {}
    }, JSON.stringify(buildFakeSession()));
    console.log('navigating to', TARGET_URL);
    await withTimeout(page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' }), 20000, 'goto');
    await new Promise((r) => setTimeout(r, 2500));

    console.log('opening Claire tab...');
    try {
      const r = await withTimeout(page.evaluate(() => {
        if (typeof showTab === 'function') { showTab('claire'); return 'called'; }
        return 'not found';
      }), 6000, 'showTab');
      console.log('showTab:', r);
    } catch (e) {
      console.log('showTab issue (continuing to screenshot anyway):', e.message);
    }
    await new Promise((r) => setTimeout(r, 1500));

    const clipHeight = parseInt(process.argv[4] || '300', 10);
    await withTimeout(page.screenshot({ path: OUT_PATH, clip: { x: 0, y: 0, width: 390, height: clipHeight } }), 10000, 'screenshot');
    console.log('screenshot saved:', OUT_PATH, fs.statSync(OUT_PATH).size, 'bytes');
  } finally {
    try { await withTimeout(browser.close(), 5000, 'close'); }
    catch (e) { try { const p = browser.process(); if (p) p.kill('SIGKILL'); } catch (e2) {} }
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error('CRASH', e.message); process.exit(1); });
