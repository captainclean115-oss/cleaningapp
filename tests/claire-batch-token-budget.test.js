// Bug report (Sept 2026, third report on this flow): Tom's real
// reproduction -- "S1 9/8-934-637 10lunch ..." (8 dates), then "all 4" --
// hit MAX_TOOL_ROUNDS and Claire never showed a preview, replying only
// "Still working through that -- nothing's confirmed saved yet."
//
// tests/claire-batch-preview-scale.test.js already proves the JS-side
// batch dispatcher has no scale bug at Tom's exact 32-entry (4 employee x
// 8 date) size -- it resolves and writes all 32 correctly. This test
// isolates the OTHER half: the LLM-side token budget. voice mode capped
// max_tokens at 400 (sized for a short spoken sentence), but a 32-entry
// batch_edit_employee_hours tool_use call and the human-readable preview
// text Claude must write afterward (per the HOURS FLOW system-prompt
// example: one line per entry) BOTH independently exceed 400 tokens by a
// wide margin -- so the round that would have produced either one could
// never finish, Claude retried, and MAX_TOOL_ROUNDS ran out before any
// preview or wrap-up ever rendered. That's confirmed here by measuring the
// real serialized JSON against the real CLAIRE_TOOLS schema shape, not an
// invented example.
//
// Also covers the new _clairePreviewSummary/_claireErrorSummary helpers
// (extracted verbatim from index.html), which the round-cap and
// "no text/no tool_use" fallbacks now use so that IF a future edge case
// still exhausts the round budget, Claire shows the real preview/error she
// already has instead of a vague "still working" status -- the fix for
// "she never showed a preview, never explained what went wrong."
//
// Run with: node tests/claire-batch-token-budget.test.js

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

// ==== Token-budget measurement against the REAL CLAIRE_TOOLS schema ====
{
  const start = src.indexOf('var CLAIRE_TOOLS = [');
  const end = src.indexOf('\n];', start) + 3;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end), sandbox);
  const tools = sandbox.CLAIRE_TOOLS;
  const batchTool = tools.find(function (t) { return t.name === 'batch_edit_employee_hours'; });
  check('batch_edit_employee_hours schema found in the real CLAIRE_TOOLS array', !!batchTool);

  // Build a 32-entry payload matching the schema's own field names/shapes
  // (employee, date, start, end, lunch) -- Tom's exact reproduction size.
  const entries = [];
  const dates = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
  const emps = ['Fatima Staff', 'Franchesca Lara', 'Nadia Barros', 'Natalia Fernandes'];
  const times = [['09:34', '18:37'], ['09:06', '18:10'], ['09:10', '19:22'], ['09:18', '15:51'], ['09:16', '19:39'], ['09:21', '18:11'], ['09:17', '18:31'], ['09:23', '17:31']];
  dates.forEach(function (d, i) {
    emps.forEach(function (e) { entries.push({ employee: e, date: d, start: times[i][0], end: times[i][1], lunch: '10' }); });
  });
  const toolCallJson = JSON.stringify({ entries: entries, confirmed: false });
  const approxTokens = Math.ceil(toolCallJson.length / 4); // standard conservative chars/4 estimate

  check('the 32-entry tool_use JSON is measured, not assumed (sanity: non-trivial size)', toolCallJson.length > 1000);
  check('the 32-entry tool_use call alone (~' + approxTokens + ' est. tokens) exceeds the OLD 400-token voice-mode ceiling', approxTokens > 400);

  // The human-readable preview text Claude must ALSO produce, per the
  // HOURS FLOW system-prompt's own example format ("one line per
  // person/day, current -> proposed").
  const previewLines = entries.map(function (e) { return '- ' + e.employee + ' ' + e.date + ': currently 8:45 AM - 5:00 PM -> ' + e.start + ' - ' + e.end; });
  const previewText = 'About to set these ' + entries.length + ':\n' + previewLines.join('\n') + '\nConfirm all?';
  const approxPreviewTokens = Math.ceil(previewText.length / 4);
  check('the follow-up preview text (~' + approxPreviewTokens + ' est. tokens) ALSO exceeds the OLD 400-token ceiling on its own', approxPreviewTokens > 400);

  // Both must fit comfortably under the NEW ceiling with real margin.
  const maxTokensMatch = src.match(/max_tokens: \(_claireMode === 'research'\) \? 2000 : (\d+),/);
  check('the new voice-mode max_tokens value was found in index.html', !!maxTokensMatch);
  const newCeiling = maxTokensMatch ? parseInt(maxTokensMatch[1], 10) : 0;
  check('the new voice-mode ceiling comfortably covers the 32-entry tool call (2x+ margin)', newCeiling >= approxTokens * 2);
  check('the new voice-mode ceiling comfortably covers the 32-entry preview text (2x+ margin)', newCeiling >= approxPreviewTokens * 2);
}

// ==== _clairePreviewSummary / _claireErrorSummary ====
function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker: ' + endMarker); process.exit(1); }
  return src.slice(s, e);
}
const previewSrc = extract(
  'function _clairePreviewSummary(toolName, resStr) {',
  '\n\nfunction _claireErrorSummary'
);
const errorSrc = extract(
  'function _claireErrorSummary(toolName, resStr) {',
  '\n\n// Bug fix (recurrence report'
);

function runPreviewSummary(toolName, resStr) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(previewSrc + '\nvar __r = _clairePreviewSummary(' + JSON.stringify(toolName) + ', ' + JSON.stringify(resStr) + ');', sandbox);
  return sandbox.__r;
}
function runErrorSummary(toolName, resStr) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(errorSrc + '\nvar __r = _claireErrorSummary(' + JSON.stringify(toolName) + ', ' + JSON.stringify(resStr) + ');', sandbox);
  return sandbox.__r;
}

const bigPreview = JSON.stringify({
  preview: true,
  changes: [
    { employee: 'Fatima Staff', date: '2026-09-08', current: '8:45 AM - 5:00 PM', proposed: '9:34 AM - 6:37 PM' },
    { employee: 'Nadia Barros', date: '2026-09-08', current: 'OFF (Vacation)', proposed: '9:34 AM - 6:37 PM' },
  ]
});
const previewSummary = runPreviewSummary('batch_edit_employee_hours', bigPreview);
check('a real preview JSON produces a non-null, showable summary', !!previewSummary);
check('the preview summary names every employee', previewSummary.indexOf('Fatima Staff') !== -1 && previewSummary.indexOf('Nadia Barros') !== -1);
check('the preview summary shows current -> proposed for the vacation-override entry', previewSummary.indexOf('OFF (Vacation)') !== -1);
check('the preview summary asks for confirmation, not a vague status', /confirm/i.test(previewSummary));

check('a write-success result (not a preview) produces no preview summary', runPreviewSummary('batch_edit_employee_hours', JSON.stringify({ success: true, count: 1, updated: [] })) === null);
check('a non-batch tool never produces a preview summary', runPreviewSummary('edit_employee_hours', bigPreview) === null);

const resolutionError = JSON.stringify({ error: 'entry_resolution_failed', errors: [{ index: 0, employee: 'Ffatima', error: 'employee_not_found' }], resolved_count: 3, total: 4 });
const errSummary1 = runErrorSummary('batch_edit_employee_hours', resolutionError);
check('an entry_resolution_failed error produces a concrete, named summary', !!errSummary1 && errSummary1.indexOf('Ffatima') !== -1);

const writeFailError = JSON.stringify({ error: 'batch_write_failed', failed_at: { index: 2, employee: 'Nadia Barros', message: 'network timeout' }, attempted: 32, written_before_failure: 2 });
const errSummary2 = runErrorSummary('batch_edit_employee_hours', writeFailError);
check('a batch_write_failed error names who/what failed', !!errSummary2 && errSummary2.indexOf('Nadia Barros') !== -1 && errSummary2.indexOf('network timeout') !== -1);

const thrownError = 'Tool batch_edit_employee_hours threw: Supabase connection reset';
const errSummary3 = runErrorSummary('batch_edit_employee_hours', thrownError);
check('a JS-level thrown error is summarized plainly', !!errSummary3 && errSummary3.indexOf('Supabase connection reset') !== -1);

check('a clean success result produces no error summary', runErrorSummary('batch_edit_employee_hours', JSON.stringify({ success: true, count: 1, updated: [] })) === null);
check('a clean preview result produces no error summary', runErrorSummary('batch_edit_employee_hours', bigPreview) === null);

// ==== The round-cap fallback never says "still working" again ====
// (Matches the exact old claireReply(...) string, not the historical
// comment nearby that references the old wording for context.)
check('the old uninformative claireReply("Still working through that...") call is gone from index.html', src.indexOf("claireReply('Still working through that") === -1);
check('the round-cap branch now checks lastPreview before falling back', src.indexOf('} else if (lastPreview) {') !== -1);
check('the round-cap branch now checks lastError before falling back', src.indexOf('} else if (lastError) {') !== -1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
