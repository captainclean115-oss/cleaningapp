// Tom: "also an easy way to get to submitted forms under staff icon."
// There was already a full business-wide "Incoming Forms" inbox under the
// Updates tab (v11.0.25, forms-inbox-list/forms-inbox-pill, review button
// per form, deep-links to the right employee's Forms tab) -- Tom just had
// no path to it from Staff. Added a "📋 Forms" shortcut button on the
// Staff landing view that jumps to it (showTab('tasks') + scroll), with
// its own badge (#staff-forms-shortcut-badge).
//
// Rather than add a second, independent pending-count computation (which
// is exactly the class of bug that caused the Updates home-tile badge to
// go stale -- see home-tile-forms-badges.test.js), the new badge is kept
// in sync inside the EXISTING renderFormsInbox(), which already re-runs
// on every PentaForms cache change. This test extracts the real function
// (not a reimplementation) and confirms both badges move together.
//
// Run with: node tests/staff-forms-shortcut-badge.test.js

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

const startMarker = 'function renderFormsInbox() {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find renderFormsInbox()'); process.exit(1); }
// Only need through the badge-sync + early-return block for this test --
// stop right before the HTML row-building map(), which needs unrelated
// helpers (_FORMS_INBOX_META etc.) not under test here.
const cutMarker = "  if (!listEl) return;\n  if (pending.length === 0) {";
const cutIdx = src.indexOf(cutMarker, startIdx);
if (cutIdx === -1) { console.error('FAIL: could not find the badge-sync cut boundary'); process.exit(1); }
const fnSource = src.slice(startIdx, cutIdx) + "  if (!listEl) return;\n}\n";

function buildSandbox(pendingForms, hasListEl, hasBadgeEl) {
  const els = {
    'forms-inbox-list': hasListEl ? { innerHTML: '' } : null,
    'forms-inbox-pill': hasListEl ? { textContent: '', style: {} } : null,
    'staff-forms-shortcut-badge': hasBadgeEl ? { textContent: '', style: {} } : null,
  };
  const sandbox = {
    console,
    document: { getElementById: function(id) { return els[id] || null; } },
    window: { PentaForms: { listSync: function() { return pendingForms; } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  sandbox.renderFormsInbox();
  return els;
}

// Both badges present (normal case: Staff view was opened at least once
// this session, so its DOM exists, even if currently hidden behind another tab).
{
  const forms = [{ id: 'f1', status: 'pending' }, { id: 'f2', status: 'approved' }, { id: 'f3', status: 'pending' }];
  const els = buildSandbox(forms, true, true);
  check('forms-inbox-pill shows the pending count', els['forms-inbox-pill'].textContent, 2);
  check('staff-forms-shortcut-badge shows the SAME pending count (no drift)', els['staff-forms-shortcut-badge'].textContent, 2);
  check('forms-inbox-pill is visible when there are pending forms', els['forms-inbox-pill'].style.display, '');
  check('staff-forms-shortcut-badge is visible when there are pending forms', els['staff-forms-shortcut-badge'].style.display, '');
}

// Zero pending -- both badges hide.
{
  const els = buildSandbox([{ id: 'f1', status: 'approved' }], true, true);
  check('forms-inbox-pill hides when nothing is pending', els['forms-inbox-pill'].style.display, 'none');
  check('staff-forms-shortcut-badge hides when nothing is pending', els['staff-forms-shortcut-badge'].style.display, 'none');
}

// The Staff view's badge element exists even though the inbox list itself
// was never mounted this session (e.g. Updates tab never opened) --
// function must still update the badge, not bail out early.
{
  const els = buildSandbox([{ id: 'f1', status: 'pending' }], false, true);
  check('staff-forms-shortcut-badge still updates even when forms-inbox-list is absent from the DOM', els['staff-forms-shortcut-badge'].textContent, 1);
}

// Neither element mounted (very first paint, no relevant DOM yet) -- must not throw.
{
  let threw = null;
  try { buildSandbox([{ id: 'f1', status: 'pending' }], false, false); } catch (e) { threw = e; }
  check('does not throw when neither the inbox list nor the shortcut badge exist', threw, null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
