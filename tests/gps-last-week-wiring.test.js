// _loadGPSDataInner() is a large function with heavy live-Geotab/DOM
// dependencies -- not practical to extract wholesale into a vm sandbox
// (same reasoning as tests/claire-edit-employee-hours-awaits-save.test.js
// for the Claire tool dispatcher). This asserts the "Last week" branch's
// exact shape in source instead: it must be checked BEFORE the generic
// rolling-window branch (so it doesn't fall through to the wrong
// ROLLING_MS lookup), must call _computeLastPayWeekRange with the
// BUSINESS timezone (not a bare `new Date()`/browser-local guess), and
// must stash the computed range for the label function to read.
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

// ---- The select element offers the new option ----
check('the GPS activity window select has a "lastweek" option', /<option value="lastweek">/.test(src), true);

// ---- _loadGPSDataInner's branch ordering and wiring ----
const branchStart = src.indexOf("if (actWindow === 'lastweek') {");
check('the lastweek branch exists', branchStart !== -1, true);
const rollingBranchStart = src.indexOf("} else if (isRollingWindow) {", branchStart);
check('the lastweek branch appears BEFORE the generic rolling-window branch (else-if chain)', rollingBranchStart > branchStart, true);

const branchBody = src.slice(branchStart, rollingBranchStart);
check('the branch calls _computeLastPayWeekRange', /_computeLastPayWeekRange\(/.test(branchBody), true);
check('it passes the BUSINESS timezone, not a bare browser-local Date', /_computeLastPayWeekRange\(_pentaBusinessTimezone\(\)\)/.test(branchBody), true);
check('fromDate/toDate are assigned from the computed range', /fromDate\s*=\s*_lastWeekRange\.fromDate/.test(branchBody) && /toDate\s*=\s*_lastWeekRange\.toDate/.test(branchBody), true);
check('the computed range is stashed on window for the label function to read', /window\._gpsLastWeekRange\s*=\s*_lastWeekRange/.test(branchBody), true);

// ---- _gpsActivityWindowLabel shows the real date range, not a generic label ----
const labelStart = src.indexOf('function _gpsActivityWindowLabel() {');
check('the label function exists', labelStart !== -1, true);
const labelEnd = src.indexOf('\n}\n', labelStart);
const labelBody = src.slice(labelStart, labelEnd);
check('the label branches on lastweek before falling back to the generic map', /mode === 'lastweek'/.test(labelBody), true);
check('it reads window._gpsLastWeekRange to build the label (not a hardcoded string)', /window\._gpsLastWeekRange/.test(labelBody), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
