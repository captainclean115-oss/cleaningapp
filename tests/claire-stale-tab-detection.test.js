// Bug report (Sept 2026): Tom reported PR #188's max_tokens fix (400 ->
// 3000) "didn't take effect" -- same "Still working through that" symptom.
// Diagnosis (via Supabase MCP, not guesswork):
//   1. git log / grep on index.html confirmed the deployed SOURCE has
//      max_tokens: 3000 at the correct call site (24873) -- the fix is
//      really there, not reverted, not shadowed by a duplicate.
//   2. GitHub's Pages Build API confirmed the commit with that fix (6c045d1)
//      was built and live server-side at 2026-09-18T00:58:11Z.
//   3. The claire-chat Edge Function is a pure passthrough (verified via
//      mcp__supabase__get_edge_function) -- it does not clamp or override
//      max_tokens, so it can't be a second, hidden ceiling.
//   4. mcp__supabase__query_logs on claire-chat's own request-body logging
//      showed EVERY request between 01:07:50Z and 01:08:28Z -- 9+ minutes
//      AFTER the fix went live server-side -- still carrying max_tokens=400,
//      with messages_count climbing round over round (21 -> 40), exactly
//      the MAX_TOOL_ROUNDS loop from the ORIGINAL bug, never fixed at all
//      for that browser session.
// Conclusion: the fix was correct and genuinely deployed; the browser
// Tom tested with was simply still running the OLD JavaScript. This app
// has no service worker and no build-time cache-busting, and `curl -I` on
// the live URL confirmed GitHub Pages serves index.html with
// `cache-control: max-age=600` (a 10-minute CDN cache window) ON TOP OF
// the more fundamental fact that an already-open tab never refetches
// index.html at all until manually reloaded -- a page loaded before a
// deploy runs that exact old code indefinitely with zero indication
// anything shipped. That's what made a real, working fix look broken.
//
// Fix: _pentaCheckForUpdate() periodically HEADs the page itself and
// compares the ETag/Last-Modified this tab loaded with against the
// server's current value; a mismatch shows a small "Refresh" banner. This
// test extracts _pentaCheckForUpdate/_pentaShowUpdateBanner verbatim from
// index.html and exercises them against a mocked fetch/DOM.
//
// Run with: node tests/claire-stale-tab-detection.test.js

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
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e + endMarker.length);
}

// ==== Sanity: the actual bug -- confirm the real max_tokens call site is
// 3000, not 400, and that no duplicate/leftover 400 exists for THIS flow.
{
  check('processVoiceCommand\'s tool-loop max_tokens is 3000 for voice mode (the shipped fix)', src.indexOf("max_tokens: (_claireMode === 'research') ? 2000 : 3000,") !== -1, true);
  check('the old max_tokens: 400 flat value for this exact call site is gone', src.indexOf("max_tokens: (_claireMode === 'research') ? 2000 : 400,") === -1, true);
}

// ==== _pentaCheckForUpdate / _pentaShowUpdateBanner ====
const checkForUpdateSrc = extract('async function _pentaCheckForUpdate() {', '\n}\n');
const showBannerSrc = extract('function _pentaShowUpdateBanner() {', '\n}\n');

function makeDom() {
  const els = {};
  const appended = [];
  function makeEl(id) {
    return els[id] || (els[id] = { id, _attrs: {}, style: {}, innerHTML: '', setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; } });
  }
  return {
    getElementById: (id) => (els[id] || null),
    createElement: () => { const el = { _attrs: {}, style: {}, innerHTML: '', setAttribute(k, v) { this._attrs[k] = v; } }; return el; },
    body: { appendChild: (el) => { appended.push(el); if (el.id) els[el.id] = el; } },
    _els: els,
    _appended: appended,
  };
}

async function runCheck(dom, fetchImpl) {
  const sandbox = {
    fetch: fetchImpl,
    document: dom,
    location: { href: 'https://captainclean115-oss.github.io/cleaningapp/' },
    console,
    _pentaLoadedVersionTag: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(showBannerSrc + '\n' + checkForUpdateSrc + '\nvar __run = _pentaCheckForUpdate();', sandbox);
  await sandbox.__run;
  return sandbox;
}

function fetchWithEtag(etag) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { headers: { get: (h) => (h === 'etag' ? etag : null) } };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // ---- First check ever: records the baseline tag, shows NO banner
  // (this is what prevents a false positive the instant the page loads). ----
  {
    const dom = makeDom();
    const fetchFn = fetchWithEtag('"etag-v1"');
    await runCheck(dom, fetchFn);
    check('the check uses a HEAD request (cheap -- no need to download the whole page)', fetchFn.calls[0].opts.method, 'HEAD');
    check('the check bypasses any browser-level cache on itself (cache: no-store)', fetchFn.calls[0].opts.cache, 'no-store');
    check('first-ever check does not show a banner (just records the baseline)', dom._appended.length, 0);
  }

  // ---- Same tag on every subsequent check (no new deploy): never shows
  // the banner -- must not nag on a version that hasn't actually changed. ----
  {
    const dom = makeDom();
    const sandbox = { fetch: fetchWithEtag('"etag-v1"'), document: dom, location: { href: 'x' }, console, _pentaLoadedVersionTag: null };
    vm.createContext(sandbox);
    vm.runInContext(showBannerSrc + '\n' + checkForUpdateSrc
      + '\nvar __run = (async function(){ await _pentaCheckForUpdate(); await _pentaCheckForUpdate(); await _pentaCheckForUpdate(); })();', sandbox);
    await sandbox.__run;
    check('three checks with an unchanged ETag never show the banner', dom._appended.length, 0);
  }

  // ---- Tag changes between checks (a new deploy happened): shows the
  // banner -- this is the actual fix for the reported bug. ----
  {
    const dom = makeDom();
    let etag = '"etag-v1"';
    const fetchFn = async () => ({ headers: { get: (h) => (h === 'etag' ? etag : null) } });
    const sandbox = { fetch: fetchFn, document: dom, location: { href: 'x' }, console, _pentaLoadedVersionTag: null };
    vm.createContext(sandbox);
    vm.runInContext(showBannerSrc + '\n' + checkForUpdateSrc
      + '\nvar __run = (async function(){ await _pentaCheckForUpdate(); })();', sandbox);
    await sandbox.__run;
    etag = '"etag-v2-newer-deploy"';
    vm.runInContext('var __run2 = (async function(){ await _pentaCheckForUpdate(); })();', sandbox);
    await sandbox.__run2;
    check('an ETag change between checks shows the update banner', dom._appended.length, 1);
    check('the banner offers an actual refresh action, not just a notice', dom._els['penta-update-banner'].innerHTML.indexOf('location.reload()') !== -1, true);
  }

  // ---- Banner never duplicates if shown more than once (idempotent). ----
  {
    const dom = makeDom();
    let etag = '"etag-v1"';
    const fetchFn = async () => ({ headers: { get: (h) => (h === 'etag' ? etag : null) } });
    const sandbox = { fetch: fetchFn, document: dom, location: { href: 'x' }, console, _pentaLoadedVersionTag: null };
    vm.createContext(sandbox);
    vm.runInContext(showBannerSrc + '\n' + checkForUpdateSrc
      + '\nvar __run = (async function(){ await _pentaCheckForUpdate(); })();', sandbox);
    await sandbox.__run;
    etag = '"etag-v2"';
    vm.runInContext('var __run2 = (async function(){ await _pentaCheckForUpdate(); await _pentaCheckForUpdate(); await _pentaCheckForUpdate(); })();', sandbox);
    await sandbox.__run2;
    check('repeated checks after the banner is already showing never add a second banner', dom._appended.length, 1);
  }

  // ---- A network hiccup (offline, fetch throws) never crashes the page --
  // this runs unattended on a timer, so it must fail silently. ----
  {
    const dom = makeDom();
    const sandbox = { fetch: async () => { throw new Error('network down'); }, document: dom, location: { href: 'x' }, console, _pentaLoadedVersionTag: null };
    vm.createContext(sandbox);
    let threw = false;
    try {
      vm.runInContext(showBannerSrc + '\n' + checkForUpdateSrc + '\nvar __run = _pentaCheckForUpdate();', sandbox);
      await sandbox.__run;
    } catch (e) { threw = true; }
    check('a fetch failure (offline) does not throw -- just skips this check', threw, false);
  }

  // ==== Wiring: checked on load, on return-to-foreground, and periodically ====
  check('checked on initial page load', src.indexOf("document.addEventListener('DOMContentLoaded', _pentaCheckForUpdate);") !== -1, true);
  check('checked when the tab returns to the foreground (visibilitychange)', src.indexOf('_pentaCheckForUpdate()') > -1 && src.indexOf("addEventListener('visibilitychange'") !== -1, true);
  check('checked periodically on a timer (comfortably past the CDN\'s 10-minute cache window)', /setInterval\(_pentaCheckForUpdate,\s*5\s*\*\s*60\s*\*\s*1000\)/.test(src), true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main();
