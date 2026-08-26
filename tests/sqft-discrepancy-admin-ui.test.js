// PR #148 — regression test for the Admin "Sqft Data Quality" button's
// thin JS wiring (loadSqftDiscrepancies). The actual flagging logic lives
// in flag_sqft_discrepancies() (Postgres, migration 103) and
// _sqftMismatchInfo() (index.html, covered by
// tests/sqft-data-quality-flag.test.js) -- this file only covers whether
// the button calls the right RPC and renders the result correctly.
//
// Extracted and run from the ACTUAL source in index.html (not a
// reimplementation), same convention as
// tests/recurring-projection-admin-ui.test.js.
//
// Run with: node tests/sqft-discrepancy-admin-ui.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'async function loadSqftDiscrepancies() {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find loadSqftDiscrepancies in index.html — did the admin section get refactored?');
  process.exit(1);
}
const endMarker = '\n\nasync function saveGeotabIntegrationSettings() {';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after loadSqftDiscrepancies — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(rpcImpl) {
  const elements = { 'admin-sqft-discrepancy-issues': { style: {}, textContent: '', innerHTML: '' } };
  const openClientEditCalls = [];
  const sandbox = {
    console: console,
    escapeHtml: function (s) { return String(s || '').replace(/[<>&"']/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]; }); },
    openClientEdit: function (id) { openClientEditCalls.push(id); },
    document: { getElementById: function (id) { return elements[id] || null; } },
    window: { supabaseClient: { rpc: rpcImpl } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, elements: elements, openClientEditCalls: openClientEditCalls };
}

async function main() {
  // Success: renders each flagged client with the manual-vs-records numbers.
  {
    let rpcCalledWith = null;
    const { sandbox, elements } = buildSandbox(function (name) {
      rpcCalledWith = name;
      return Promise.resolve({
        data: [{ external_id: 'C1', first_name: 'Ann', last_name: 'Lee', sqft: 2100, sqft_from_records: 3400, diff_pct: 62 }],
        error: null,
      });
    });
    await sandbox.loadSqftDiscrepancies();
    check('calls flag_sqft_discrepancies with no arguments', rpcCalledWith, 'flag_sqft_discrepancies');
    const html = elements['admin-sqft-discrepancy-issues'].innerHTML;
    check('renders the manual vs. records numbers and percentage', html.indexOf('2,100') !== -1 && html.indexOf('3,400') !== -1 && html.indexOf('62%') !== -1, true);
    check('renders the client as a clickable openClientEdit link', html.indexOf("openClientEdit('C1')") !== -1, true);
  }

  // Empty result: explicit all-clear, not a blank panel.
  {
    const { sandbox, elements } = buildSandbox(function () { return Promise.resolve({ data: [], error: null }); });
    await sandbox.loadSqftDiscrepancies();
    check('shows an explicit all-clear message when nothing is flagged', elements['admin-sqft-discrepancy-issues'].innerHTML.indexOf('No sqft mismatches') !== -1, true);
  }

  // RPC error surfaces to the user instead of silently failing.
  {
    const { sandbox, elements } = buildSandbox(function () { return Promise.resolve({ data: null, error: { message: 'permission denied' } }); });
    await sandbox.loadSqftDiscrepancies();
    check('surfaces an RPC-level error', elements['admin-sqft-discrepancy-issues'].innerHTML.indexOf('Failed to load') !== -1, true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
