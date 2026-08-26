// PR #146 — regression test for the Admin "Recurring Schedule Projection"
// section's JS wiring: runRecurringProjectionNow() (manual trigger button)
// and loadRecurringProjectionIssues() (data-quality report).
//
// The actual projection/reschedule-detection/team-fallback/rolling-window
// business logic lives entirely in Postgres (migration 102:
// project_recurring_jobs_for_business, project_recurring_jobs_now,
// flag_recurring_projection_issues) and was verified live against a
// disposable test business/clients/jobs in Supabase, then fully cleaned
// up -- there is no index.html source for that logic to extract, so it
// isn't covered by this repo's fs+vm test convention. This file covers
// only the thin JS layer: does the button call the right RPC with no
// args, surface success/error/empty-state correctly, and render flagged
// clients as clickable links to openClientEdit.
//
// Extracted and run from the ACTUAL source in index.html (not a
// reimplementation).
//
// Run with: node tests/recurring-projection-admin-ui.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

const startMarker = 'async function runRecurringProjectionNow() {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find runRecurringProjectionNow in index.html — did the admin section get refactored?');
  process.exit(1);
}
const endMarker = '\nasync function saveGeotabIntegrationSettings() {';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx === -1) {
  console.error('FAIL: could not find the end boundary after loadRecurringProjectionIssues — extraction range may need updating.');
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
  const elements = {
    'admin-recurring-projection-status': { style: {}, textContent: '', innerHTML: '' },
    'admin-recurring-projection-issues': { style: {}, textContent: '', innerHTML: '' },
  };
  const openClientEditCalls = [];
  const sandbox = {
    console: console,
    escapeHtml: function (s) { return String(s || '').replace(/[<>&"']/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]; }); },
    openClientEdit: function (id) { openClientEditCalls.push(id); },
    document: { getElementById: function (id) { return elements[id] || null; } },
    window: {
      supabaseClient: { rpc: rpcImpl },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, elements: elements, openClientEditCalls: openClientEditCalls };
}

async function main() {
  // --- runRecurringProjectionNow: success path ---
  {
    let rpcCalledWith = null;
    const { sandbox, elements } = buildSandbox(function (name, args) {
      rpcCalledWith = { name: name, args: args };
      return Promise.resolve({ data: { window_end: '2027-08-25', jobs_created: 42, clients_processed: 5, errors: [] }, error: null });
    });
    await sandbox.runRecurringProjectionNow();
    check('calls project_recurring_jobs_now with no arguments (self-scoping RPC, never a caller-supplied business_id)', rpcCalledWith, { name: 'project_recurring_jobs_now', args: undefined });
    check('renders the job/client counts on success', elements['admin-recurring-projection-status'].textContent.indexOf('42 new job') !== -1, true);
  }

  // --- runRecurringProjectionNow: surfaces per-client errors without hiding the run's success ---
  {
    const { sandbox, elements } = buildSandbox(function () {
      return Promise.resolve({ data: { window_end: '2027-08-25', jobs_created: 10, clients_processed: 6, errors: [{ client_external_id: 'X', error: 'boom' }] }, error: null });
    });
    await sandbox.runRecurringProjectionNow();
    check('mentions error count when per-client errors occurred', elements['admin-recurring-projection-status'].textContent.indexOf('1 error') !== -1, true);
  }

  // --- runRecurringProjectionNow: RPC failure (e.g. role check rejected) surfaces to the user ---
  {
    const { sandbox, elements } = buildSandbox(function () {
      return Promise.resolve({ data: null, error: { message: 'Only owner/admin/manager/dispatcher can run schedule projection' } });
    });
    await sandbox.runRecurringProjectionNow();
    check('surfaces an RPC-level error (e.g. role rejection) instead of silently no-op-ing', elements['admin-recurring-projection-status'].textContent.indexOf('Projection failed') !== -1, true);
  }

  // --- loadRecurringProjectionIssues: renders flagged clients as clickable links, grouped by issue ---
  {
    let rpcCalledWith = null;
    const { sandbox, elements, openClientEditCalls } = buildSandbox(function (name) {
      rpcCalledWith = name;
      return Promise.resolve({
        data: [
          { external_id: 'C1', first_name: 'Ann', last_name: 'Lee', issue: 'missing_anchor_date' },
          { external_id: 'C2', first_name: 'Bo', last_name: 'Ng', issue: 'missing_frequency' },
        ],
        error: null,
      });
    });
    await sandbox.loadRecurringProjectionIssues();
    check('calls flag_recurring_projection_issues with no arguments', rpcCalledWith, 'flag_recurring_projection_issues');
    const html = elements['admin-recurring-projection-issues'].innerHTML;
    check('groups results under a human label per issue type', html.indexOf('Missing anchor date') !== -1 && html.indexOf('Missing frequency') !== -1, true);
    check('renders each flagged client as a clickable openClientEdit link', html.indexOf("openClientEdit('C1')") !== -1, true);
  }

  // --- loadRecurringProjectionIssues: empty result shows a clear all-clear, not a blank panel ---
  {
    const { sandbox, elements } = buildSandbox(function () { return Promise.resolve({ data: [], error: null }); });
    await sandbox.loadRecurringProjectionIssues();
    check('shows an explicit all-clear message when nothing is flagged', elements['admin-recurring-projection-issues'].innerHTML.indexOf('No data quality issues') !== -1, true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
