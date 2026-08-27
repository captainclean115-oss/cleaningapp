// PR #150 — regression test for the Terminate Employee modal's
// "Eligible for rehire" toggle not persisting the chosen value.
//
// Diagnosis found this was NOT the PR #138 silent-write-path bug class --
// _toRow correctly maps eligible_for_rehire (read AND write), and
// terminateEmployee() correctly includes it in the PentaEmployees.update()
// payload (both already covered by tests/employee-termination-flow.test.js
// and re-verified live against Supabase: writing eligible_for_rehire=false
// persisted correctly at the raw DB level).
//
// The actual bug was a DOM event-handling defect the existing Node+vm test
// convention structurally CANNOT catch (it stubs document.getElementById
// and never simulates real click/label event bubbling): the checkbox was
// wrapped in a <label>, AND both visual spans had onclick="...click()"
// handlers manually forwarding clicks to the checkbox. A native <label>
// ALSO forwards an unhandled click on a non-control descendant to its
// associated control -- so every real user click toggled the checkbox
// TWICE (once from the manual .click() call, once from the label's own
// native forwarding), netting to no change. The checkbox's `checked`
// state almost never actually changed from user interaction, regardless
// of how many times someone clicked it -- and there was no :checked-
// driven visual feedback either, so nothing looked wrong until you
// actually checked what got saved.
//
// Since a real click/label-bubbling simulation is out of reach for this
// repo's test convention, this file is a structural guard: it asserts the
// exact antipattern (manual click-forwarding onclick handlers on a
// label-wrapped toggle) is absent, and that the fixed markup follows the
// SAME pattern as the already-proven-working .admin-switch toggle used
// elsewhere in this codebase (pure native label + CSS :checked-sibling-
// selector, no manual JS toggling at all).
//
// Run with: node tests/employee-termination-rehire-toggle.test.js

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + expected + ', got ' + actual); }
}

const markerIdx = src.indexOf('id="term-modal-rehire"');
if (markerIdx === -1) {
  console.error('FAIL: could not find term-modal-rehire in index.html — did the Terminate Employee modal get refactored?');
  process.exit(1);
}
// Grab the whole toggle block: from the enclosing <label> start to its close.
const labelStart = src.lastIndexOf('<label', markerIdx);
const labelEnd = src.indexOf('</label>', markerIdx) + '</label>'.length;
const toggleMarkup = src.slice(labelStart, labelEnd);

check(
  'the toggle\'s label carries the term-rehire-switch class (the fixed, CSS-:checked-driven pattern)',
  /class="term-rehire-switch"/.test(toggleMarkup),
  true
);
check(
  'no element inside the toggle manually forwards clicks to the checkbox via .click() -- this exact pattern, combined with the wrapping <label>\'s own native forwarding, is what double-toggled and canceled out every real user click',
  /\.click\(\)/.test(toggleMarkup),
  false
);
check(
  'no onclick attribute exists anywhere inside the toggle at all (native label semantics only, matching the proven .admin-switch pattern)',
  /onclick=/.test(toggleMarkup),
  false
);
check(
  'the checkbox itself has no inline opacity/size hack left over from the old markup (moved to the term-rehire-switch CSS class instead)',
  /id="term-modal-rehire"[^>]*style=/.test(toggleMarkup),
  false
);

// The CSS driving term-rehire-switch must actually exist and be keyed off
// :checked, or the toggle would work functionally but never show its state.
const cssStart = src.indexOf('.term-rehire-switch {');
check('the term-rehire-switch CSS class is defined', cssStart !== -1, true);
if (cssStart !== -1) {
  const cssBlock = src.slice(cssStart, cssStart + 800);
  check('CSS includes a :checked-driven track color change', /input:checked \+ \.term-rehire-track\s*\{/.test(cssBlock), true);
  check('CSS includes a :checked-driven thumb position change', /input:checked \+ \.term-rehire-track::before/.test(cssBlock), true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
