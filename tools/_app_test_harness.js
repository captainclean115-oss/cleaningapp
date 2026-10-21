// Shared headless-Chrome test harness for booting index.html into a
// logged-out / manager / employee-portal state, with ALL Supabase
// network traffic intercepted and stubbed in-browser -- nothing here
// ever reaches the real wymoezilyjmyibmuqqmr project. Used to verify
// PR #201 (the pentaShowInviteSendModal outage fix) across the three
// session states and the specific screens that PR #199's rewrite
// touched, without a real login or any real database read/write.
'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const FAKE_AUTH_ID = '11111111-1111-4111-8111-111111111111';
const FAKE_BIZ_ID  = '22222222-2222-4222-8222-222222222222';
const FAKE_EMP_ID  = '33333333-3333-4333-8333-333333333333';

function buildFakeSession(mode) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: 'fake.' + mode + '.token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: nowSec + 3600,
    refresh_token: 'fake-refresh-' + mode,
    user: {
      id: FAKE_AUTH_ID,
      aud: 'authenticated',
      email: mode === 'employee' ? 'fixture.employee@test.local' : 'fixture.manager@test.local',
      app_metadata: {},
      user_metadata: { is_employee: mode === 'employee' },
    },
  };
}

// Fixture rows -- just enough columns for the boot router + the
// specific screens this harness drives through. Anything not listed
// here falls through to the generic REST/function stub below.
function usersFixtureRow(mode) {
  if (mode === 'manager') {
    return { role: 'owner', manager_permissions: {}, business_id: FAKE_BIZ_ID, first_name: 'Fixture', phone: null };
  }
  return { role: 'employee', manager_permissions: {}, business_id: FAKE_BIZ_ID, first_name: 'Fixture', phone: null };
}

function employeeFixtureRow() {
  return {
    id: FAKE_EMP_ID,
    legacy_roster_id: 9001,
    first_name: 'Fixture',
    last_name: 'Employee',
    team_text: 'Team A',
    team_id: null,
    culture_tag: 'us',
    position: 'team_member',
    photo_url: '',
    status: 'active',
    terminated_at: null,
    auth_user_id: FAKE_AUTH_ID,
    work_type: 'field',
    pay_type: 'hourly',
    phone: '7815550101',
    email: 'fixture.employee@test.local',
    deleted_at: null,
  };
}

function businessFixtureRow() {
  return { name: 'Fixture Cleaning Co', legal_name: 'Fixture Cleaning Co LLC', timezone: 'America/New_York', pay_week_start_day: 1 };
}

function isSingularRequest(headers) {
  const accept = (headers['accept'] || headers['Accept'] || '');
  return accept.indexOf('vnd.pgrst.object') !== -1;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Credentials': 'true',
};

async function installInterception(page, mode, requestLog) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    try {
      if (requestLog && url.indexOf('supabase.co') !== -1 && req.method() !== 'OPTIONS') {
        requestLog.push(url);
      }
      if (url.indexOf('supabase.co') === -1) {
        req.continue();
        return;
      }

      // Every real browser fetch to a cross-origin host preflights with
      // OPTIONS first. Puppeteer's interception still enforces real CORS
      // on whatever headers we hand back, so every branch below must
      // include CORS_HEADERS, and OPTIONS itself must short-circuit here.
      if (req.method() === 'OPTIONS') {
        req.respond({ status: 204, headers: CORS_HEADERS, body: '' });
        return;
      }

      const respond = (status, body) => req.respond({
        status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
        body: JSON.stringify(body),
      });

      // --- Auth endpoints: never let a real call out with our forged token.
      if (url.indexOf('/auth/v1/') !== -1) {
        respond(200, buildFakeSession(mode));
        return;
      }

      // --- Edge Functions.
      if (url.indexOf('/functions/v1/send-invite') !== -1) {
        respond(200, { success: true });
        return;
      }
      if (url.indexOf('/functions/v1/rc-inbox') !== -1) {
        respond(200, { messages: [] });
        return;
      }
      if (url.indexOf('/functions/v1/') !== -1) {
        respond(200, { success: true, ok: true });
        return;
      }

      // --- REST (PostgREST) endpoints.
      if (url.indexOf('/rest/v1/') !== -1) {
        const headers = req.headers();
        const singular = isSingularRequest(headers);
        const method = req.method();

        if (method !== 'GET') {
          // Any write -- never reaches real Supabase regardless; respond
          // with a minimal success shape so calling code doesn't throw.
          respond(200, singular ? {} : []);
          return;
        }

        const table = (url.match(/\/rest\/v1\/([a-zA-Z0-9_]+)/) || [])[1] || '';

        if (table === 'users') {
          respond(200, singular ? usersFixtureRow(mode) : [usersFixtureRow(mode)]);
          return;
        }
        if (table === 'employees') {
          respond(200, singular ? employeeFixtureRow() : [employeeFixtureRow()]);
          return;
        }
        if (table === 'businesses') {
          respond(200, singular ? businessFixtureRow() : [businessFixtureRow()]);
          return;
        }

        // Generic default: empty-but-valid shape, same as a brand-new
        // tenant with no rows yet in that table (a real state the app
        // already has to handle).
        respond(200, singular ? null : []);
        return;
      }

      // --- RPCs.
      if (url.indexOf('/rest/v1/rpc/') !== -1 || url.indexOf('/rpc/') !== -1) {
        respond(200, true);
        return;
      }

      respond(200, []);
    } catch (e) {
      try { req.continue(); } catch (_e2) {}
    }
  });
}

async function launchBrowser() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('No local Chrome/Chromium found.');
  return puppeteer.launch({ executablePath: chromePath, headless: true });
}

/**
 * Boots index.html in the given mode ('loggedOut' | 'manager' | 'employee').
 * Returns { page, pageErrors, consoleErrors, consoleWarnings } where the
 * error arrays are LIVE (mutated as the page keeps running) so callers
 * can snapshot .length before/after an action to attribute new errors.
 */
async function bootPage(browser, mode, indexFileUrl) {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  const requestLog = [];

  page.on('pageerror', (err) => pageErrors.push(err.stack || err.message || String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });

  await installInterception(page, mode, requestLog);

  // Supabase Realtime opens a persistent WebSocket; Puppeteer's HTTP
  // request interception doesn't see it (not a plain HTTP request), and
  // a real connection attempt to our stub Authorization header would
  // just hang retrying forever -- stub WebSocket itself to a harmless
  // no-op so nothing ever waits on it.
  await page.evaluateOnNewDocument(() => {
    window.WebSocket = function FakeWebSocket() {
      this.readyState = 3; // CLOSED
      this.close = function () {};
      this.send = function () {};
      this.addEventListener = function () {};
      this.removeEventListener = function () {};
    };
  });

  if (mode !== 'loggedOut') {
    const session = buildFakeSession(mode);
    await page.evaluateOnNewDocument((sessionJson) => {
      try {
        window.localStorage.setItem('sb-wymoezilyjmyibmuqqmr-auth-token', sessionJson);
      } catch (e) {}
    }, JSON.stringify(session));
  }

  // Not networkidle2: a real session opens a persistent Supabase
  // Realtime WebSocket, which Puppeteer's request interception doesn't
  // catch (not a plain HTTP request) and which never goes idle, so
  // networkidle2 would just time out waiting for it.
  await page.goto(indexFileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // supabase-js v2's GoTrueClient serializes auth calls behind an
  // internal lock (navigator.locks when available). The FIRST call to
  // sb.auth.getUser() in a fresh page pays a one-time ~20s+ latency cost
  // under this forged/stubbed session (confirmed by direct measurement:
  // 23561ms on an otherwise-idle page) before the lock settles -- every
  // call after that is fast. Several independent in-memory caches
  // (PentaEmployees, PentaTeams, PentaJobs, PentaAssignments,
  // PentaRewards) each separately derive business_id via their own
  // copy of a "Path A: PentaEmployees cache, Path B: own auth+users
  // query" chain, each path individually timeout-wrapped at 3s. Under a
  // real login every one of these resolves near-instantly from a warm
  // shared cache; under this stub session every one of them starts
  // cold, so the FIRST real screen interaction otherwise pays all of
  // this compounding latency at once (confirmed: still exceeded a 25s
  // per-action watchdog even after warming the auth lock alone).
  // Warming PentaEmployees.ready() here (which itself loads PentaTeams)
  // pays that cost ONCE, up front, with a generous allowance, so every
  // real action afterward hits warm caches and is fast.
  if (mode !== 'loggedOut') {
    const warmup = page.evaluate(async () => {
      try {
        const sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
        if (sb) await sb.auth.getUser();
      } catch (e) {}
      // Warm every independent singleton cache's own ready()/load() IN
      // PARALLEL (not sequentially) -- each pays its own up-to-6s Path
      // A/B cost under this stub session, but since they're independent
      // of each other, running them together costs roughly the slowest
      // one, not the sum of all five.
      const modules = [
        ['PentaEmployees', 'ready'],
        ['PentaTeams', 'load'],
        ['PentaJobs', 'ready'],
        ['PentaAssignments', 'ready'],
        ['PentaRewards', 'ready'],
      ];
      await Promise.all(modules.map(([name, method]) => (async () => {
        try {
          const mod = window[name];
          if (mod && typeof mod[method] === 'function') await mod[method]();
        } catch (e) {}
      })()));
    });
    // Node-level safety cap: never let a stuck warm-up hang bootPage()
    // forever, even though every step above already has its own
    // in-browser try/catch.
    await Promise.race([warmup, new Promise((r) => setTimeout(r, 45000))]);
  }

  await new Promise((r) => setTimeout(r, 2000));

  return { page, pageErrors, consoleErrors, consoleWarnings, requestLog };
}

module.exports = {
  findChrome,
  launchBrowser,
  bootPage,
  buildFakeSession,
  FAKE_AUTH_ID,
  FAKE_BIZ_ID,
  FAKE_EMP_ID,
};
