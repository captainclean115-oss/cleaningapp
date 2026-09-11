// PentaEmployees._hydrate() had the same async-reset race already found
// and fixed this session in PentaLunchFlags/PentaHourOverrides: the
// `if (!sb) { _hydrating = null; return false; }` bail ran with no
// `await` before it, so the reset executed synchronously and was
// immediately clobbered by the outer `_hydrating = (async function(){...})()`
// assignment landing right after -- if SB() was momentarily unavailable
// on the very first ready() call (a real boot-time race), `_hydrating`
// got permanently stuck holding a resolved-false promise, and every
// later ready()/open-Teams-modal call short-circuited on it forever
// without ever retrying. Confirmed live symptom: "Teams modal opens
// completely empty... refreshing/reopening usually fixes it temporarily"
// (a fresh page load re-runs the race with new timing).
//
// Extracts the real _hydrate/_businessId/_fromRow verbatim and mocks
// only SB() (the true I/O boundary), toggling it from unavailable to
// available across two ready() calls -- same technique used for the
// original PentaLunchFlags fix proof.
//
// Run with: node tests/penta-employees-hydrate-race.test.js

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
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) { console.error('FAIL: could not find end marker after ' + startMarker); process.exit(1); }
  return src.slice(startIdx, endIdx);
}

const hydrateSrc = extract('function _hydrate() {', '\n  async function list() {');

function buildSandbox(opts) {
  opts = opts || {};
  let sbAvailable = !!opts.sbAvailableFirstCall;
  const sandbox = {
    console,
    window: { PentaTeams: null },
    _cache: [],
    _cacheReady: false,
    _hydrating: null,
    SB: function () { return sbAvailable ? { from: sandbox._fakeFrom } : null; },
    _businessId: function () { return Promise.resolve(opts.bid !== undefined ? opts.bid : 'biz-1'); },
    _fromRow: function (row) { return row; },
    _notify: function () {},
    _fakeFrom: function () {
      const chain = {
        select: function () { return chain; },
        eq: function () { return chain; },
        is: function () { return chain; },
        order: function () { return Promise.resolve({ data: opts.rows || [{ id: 'e1', first_name: 'Nadia' }], error: null }); },
      };
      return chain;
    },
    setSbAvailable: function (v) { sbAvailable = v; },
  };
  vm.createContext(sandbox);
  vm.runInContext(hydrateSrc, sandbox);
  return sandbox;
}

async function main() {
  // ---- SB() unavailable on the first hydrate call must NOT permanently
  // strand `_hydrating` -- a later call, once SB() is available, must
  // actually retry and succeed. ----
  {
    const sandbox = buildSandbox({ sbAvailableFirstCall: false });
    const first = await sandbox._hydrate();
    check('first hydrate (no sb client yet) resolves false', first, false);
    check('_hydrating is cleared after the failed attempt, not stuck', sandbox._hydrating, null);

    sandbox.setSbAvailable(true);
    const second = await sandbox._hydrate();
    check('second hydrate (sb now available) actually retries and succeeds', second, true);
    check('cache is populated after the successful retry', sandbox._cache, [{ id: 'e1', first_name: 'Nadia' }]);
    check('_cacheReady flips true', sandbox._cacheReady, true);
  }

  // ---- Two truly concurrent callers during a slow, eventually-successful
  // hydrate share the SAME in-flight promise (no duplicate fetch). ----
  {
    const sandbox = buildSandbox({ sbAvailableFirstCall: true });
    const p1 = sandbox._hydrate();
    const p2 = sandbox._hydrate();
    check('concurrent callers get the same in-flight promise', p1 === p2, true);
    const [r1, r2] = await Promise.all([p1, p2]);
    check('both resolve true', [r1, r2], [true, true]);
  }

  // ---- business_id resolution failing (a later await, not the
  // synchronous SB() check) must also clear _hydrating for a future retry
  // -- this path already had an await before it and was already safe,
  // confirming the fix didn't regress it. ----
  {
    const sandbox = buildSandbox({ sbAvailableFirstCall: true, bid: null });
    const first = await sandbox._hydrate();
    check('no business_id resolves false', first, false);
    check('_hydrating still clears correctly on the post-await bail path', sandbox._hydrating, null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
