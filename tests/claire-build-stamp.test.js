// Claire build stamp -- always visible, not gated on the view opening.
//
// Context: PR #220 added a build stamp to Claire's header so Tom could
// tell which version was actually running on his phone (this app has
// no service worker, so an already-open tab/PWA can run old JS
// indefinitely with no prompt to reload). That first version only
// rendered the stamp inside showTab's `tab === 'claire'` branch --
// correct once Claire's tab is opened, but the rendering itself was
// conditioned on that event firing. Fixed to render unconditionally,
// once, at script-load time, since #claire-build-stamp is static
// markup already present in the DOM by then.
//
// This extracts the REAL CLAIRE_BUILD_STAMP/_claireRenderBuildStamp
// code (including its own unconditional self-invoking call) verbatim
// from index.html and proves the stamp is populated with NO call to
// showTab/_claireOpenView/any tab-switch event at all -- i.e. that
// visibility genuinely does not depend on the view ever opening.
//
// Run with: node tests/claire-build-stamp.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}

const stampSrc = extract(
  'var CLAIRE_BUILD_STAMP = ',
  "_claireRenderBuildStamp();"
) + "_claireRenderBuildStamp();";

// ---- Structural check: the stamp element's HTML must exist BEFORE the
// main <script> tag that defines/invokes _claireRenderBuildStamp --
// otherwise an unconditional call at script-load time would silently
// find a null element (document.getElementById returns null for
// markup that hasn't been parsed yet). This is what actually makes the
// "render immediately, no DOMContentLoaded needed" approach safe. ----
{
  const divIdx = src.indexOf('<div id="claire-build-stamp"');
  const scriptIdx = src.indexOf('var CLAIRE_BUILD_STAMP = ');
  check('the #claire-build-stamp element is defined in markup BEFORE the script that renders it', divIdx !== -1 && divIdx < scriptIdx);
}

// ---- The real stamp code, run in total isolation (no showTab, no
// _claireOpenView, no tab-switch of any kind -- simulating script-load
// on a page where Claire's tab is never opened) must still populate
// the element. This is the literal "not gated on the view opening"
// requirement. ----
{
  let elementState = { textContent: '' };
  const sandbox = {
    console,
    document: {
      getElementById: function (id) {
        return id === 'claire-build-stamp' ? elementState : null;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(stampSrc, sandbox);

  check('CLAIRE_BUILD_STAMP is defined and non-empty', typeof sandbox.CLAIRE_BUILD_STAMP === 'string' && sandbox.CLAIRE_BUILD_STAMP.length > 0);
  check('CLAIRE_BUILD_STAMP is (or starts with) a plain YYYY-MM-DD date -- readable at a glance, no build tooling needed to produce it', /^\d{4}-\d{2}-\d{2}/.test(sandbox.CLAIRE_BUILD_STAMP));
  check('the element is populated immediately, with ZERO tab-switch or Claire-view-open event', elementState.textContent.length > 0);
  check('the rendered text includes the real CLAIRE_BUILD_STAMP value', elementState.textContent.indexOf(sandbox.CLAIRE_BUILD_STAMP) !== -1);
}

// ---- Re-invoking the renderer (e.g. from showTab's own call site, for
// a long-lived open tab) is idempotent and never clears/corrupts it. ----
{
  let elementState = { textContent: '' };
  const sandbox = {
    console,
    document: { getElementById: function (id) { return id === 'claire-build-stamp' ? elementState : null; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(stampSrc, sandbox); // the module's own unconditional call
  const firstRender = elementState.textContent;
  sandbox._claireRenderBuildStamp(); // simulate showTab('claire') calling it again
  check('calling the renderer again (as showTab still does) reproduces the exact same text', elementState.textContent === firstRender);
}

// ---- The showTab call site still exists too (belt-and-suspenders for
// a long-lived open tab), but must NOT be the only thing that renders
// it -- confirmed above. This just checks the call site itself wasn't
// accidentally removed. ----
{
  const showTabCallIdx = src.indexOf("if (typeof _claireRenderBuildStamp === 'function') _claireRenderBuildStamp();");
  check('showTab(\'claire\') still re-renders the stamp too (belt-and-suspenders, not the only trigger)', showTabCallIdx !== -1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
