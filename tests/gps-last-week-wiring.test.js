// _loadGPSDataInner() is a large function with heavy live-Geotab/DOM
// dependencies -- not practical to extract wholesale into a vm sandbox
// (same reasoning as tests/claire-edit-employee-hours-awaits-save.test.js
// for the Claire tool dispatcher). This asserts the "Last week" and
// "Custom range" branches' exact shape in source instead: lastweek must
// be checked BEFORE the generic rolling-window branch, must call
// _computeLastPayWeekRange with the BUSINESS timezone AND the per-
// business pay_week_start_day setting (not a hardcoded Mon-Sun), and
// must stash the computed range for the label function to read; custom
// must read the two date-picker inputs and use business-timezone wall
// clock (not browser-local) for both boundaries.
//
// Run with: node tests/gps-last-week-wiring.test.js

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

// ---- The select element offers both new options ----
check('the GPS activity window select has a "lastweek" option', /<option value="lastweek">/.test(src), true);
check('the GPS activity window select has a "custom" option', /<option value="custom">/.test(src), true);
check('the custom-range date inputs exist', /id="gps-custom-from"/.test(src) && /id="gps-custom-to"/.test(src), true);

// ---- _loadGPSDataInner's branch ordering and wiring ----
const branchStart = src.indexOf("if (actWindow === 'lastweek') {");
check('the lastweek branch exists', branchStart !== -1, true);
const customBranchStart = src.indexOf("} else if (actWindow === 'custom') {", branchStart);
check('the custom branch exists, right after lastweek', customBranchStart > branchStart, true);
const rollingBranchStart = src.indexOf("} else if (isRollingWindow) {", customBranchStart);
check('the generic rolling-window branch comes after both lastweek and custom', rollingBranchStart > customBranchStart, true);

const lastweekBody = src.slice(branchStart, customBranchStart);
check('the lastweek branch calls _computeLastPayWeekRange', /_computeLastPayWeekRange\(/.test(lastweekBody), true);
check('it passes BOTH the business timezone AND the per-business pay-week-start setting (not hardcoded Mon-Sun)', /_computeLastPayWeekRange\(_pentaBusinessTimezone\(\),\s*_pentaPayWeekStartDay\(\)\)/.test(lastweekBody), true);
check('fromDate/toDate are assigned from the computed range', /fromDate\s*=\s*_lastWeekRange\.fromDate/.test(lastweekBody) && /toDate\s*=\s*_lastWeekRange\.toDate/.test(lastweekBody), true);
check('the computed range is stashed on window for the label function to read', /window\._gpsLastWeekRange\s*=\s*_lastWeekRange/.test(lastweekBody), true);

const customBody = src.slice(customBranchStart, rollingBranchStart);
check('the custom branch reads both date picker inputs', /getElementById\('gps-custom-from'\)/.test(customBody) && /getElementById\('gps-custom-to'\)/.test(customBody), true);
check('it builds both boundaries via the business-timezone wall-clock helper, not browser-local Date()', /_bizWallClockToUtc\(/.test(customBody), true);
check('it uses _pentaBusinessTimezone(), not a bare browser-local guess', /_pentaBusinessTimezone\(\)/.test(customBody), true);
check('it stashes the picked range on window for the label function to read', /window\._gpsCustomRange\s*=/.test(customBody), true);

// ---- _syncGPSDatePickerVisibility shows/hides the custom inputs and
// pre-fills them from the pay-week helper on first switch ----
const syncStart = src.indexOf('function _syncGPSDatePickerVisibility() {');
check('the visibility-sync function exists', syncStart !== -1, true);
const syncEnd = src.indexOf('\nfunction onGPSActivityWindowChange()', syncStart);
const syncBody = src.slice(syncStart, syncEnd);
check('it toggles the custom-range inputs based on mode', /showCustom/.test(syncBody), true);
check('it pre-fills custom dates using the same pay-week helper (not hardcoded)', /_computeLastPayWeekRange\(_pentaBusinessTimezone\(\),\s*_pentaPayWeekStartDay\(\)\)/.test(syncBody), true);

// ---- _gpsActivityWindowLabel shows the real date range for both modes ----
const labelStart = src.indexOf('function _gpsActivityWindowLabel() {');
check('the label function exists', labelStart !== -1, true);
const labelEnd = src.indexOf('\n}\n', labelStart);
const labelBody = src.slice(labelStart, labelEnd);
check('the label branches on lastweek before falling back to the generic map', /mode === 'lastweek'/.test(labelBody), true);
check('the label also branches on custom', /mode === 'custom'/.test(labelBody), true);
check('it reads window._gpsLastWeekRange to build the lastweek label (not a hardcoded string)', /window\._gpsLastWeekRange/.test(labelBody), true);
check('it reads window._gpsCustomRange to build the custom label', /window\._gpsCustomRange/.test(labelBody), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
