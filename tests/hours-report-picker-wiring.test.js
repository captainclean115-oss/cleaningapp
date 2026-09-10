// Structural checks for the Export Hours Report picker wiring --
// openHoursReportPicker/confirmHoursReportExport are DOM-heavy overlay
// builders (same reasoning as other UI-overlay functions in this file
// not being fully extracted+run: the value is in the already-tested
// pure logic, not re-verifying DOM construction). Confirms: the export
// button opens the PICKER (not an immediate report), the picker
// pre-fills from _hoursReportDefaultRange, confirming builds the
// report via _buildHoursReportForDates and only THEN shows results
// (never both at once), and the old immediate-fire behavior is gone.
//
// Run with: node tests/hours-report-picker-wiring.test.js

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

// ---- showHoursReport no longer fires the report immediately ----
const showStart = src.indexOf('function showHoursReport() {');
check('showHoursReport() exists', showStart !== -1, true);
const showEnd = src.indexOf('\n}\n', showStart);
const showBody = src.slice(showStart, showEnd);
check('showHoursReport() now opens the picker instead of building a report directly', /openHoursReportPicker\(\)/.test(showBody), true);
check('showHoursReport() no longer calls _buildHoursReport(0) (the old immediate-fire, dead function -- removed entirely)', /_buildHoursReport\(0\)/.test(showBody), false);
check('the dead _buildHoursReport/_hrReportWeekDates functions were actually removed, not just unreferenced', /function _buildHoursReport\(offset\)/.test(src) || /function _hrReportWeekDates/.test(src), false);

// ---- The picker itself has a date range, quick-selects, Export and Cancel ----
const pickerStart = src.indexOf('function openHoursReportPicker() {');
check('openHoursReportPicker() exists', pickerStart !== -1, true);
const pickerEnd = src.indexOf('\n}\n\n// "This week"', pickerStart);
const pickerBody = src.slice(pickerStart, pickerEnd);
check('the picker has From/To date inputs', /id="hours-report-from"/.test(pickerBody) && /id="hours-report-to"/.test(pickerBody), true);
check('the picker pre-fills from _hoursReportDefaultRange()', /_hoursReportDefaultRange\(\)/.test(pickerBody), true);
check('the picker has This week / Last week quick-selects', /_hoursReportQuickSelect\(.{1,2}thisweek.{1,2}\)/.test(pickerBody) && /_hoursReportQuickSelect\(.{1,2}lastweek.{1,2}\)/.test(pickerBody), true);
check('the picker has an Export button wired to confirmHoursReportExport', /onclick="confirmHoursReportExport\(\)"/.test(pickerBody), true);
check('the picker has a Cancel button', />Cancel</.test(pickerBody), true);

// ---- confirmHoursReportExport builds via the range-aware function,
// then shows results -- never both without an await between them, and
// never the old direct-fire path. ----
const confirmStart = src.indexOf('async function confirmHoursReportExport() {');
check('confirmHoursReportExport() exists', confirmStart !== -1, true);
const confirmEnd = src.indexOf('\n\n// Generalizes _buildHoursReport', confirmStart);
const confirmBody = src.slice(confirmStart, confirmEnd);
check('it awaits _buildHoursReportForDates with the picked dates', /await _buildHoursReportForDates\(dates\)/.test(confirmBody), true);
check('it renders results only via _renderHoursReportResults (shared with the old flow)', /_renderHoursReportResults\(rep\)/.test(confirmBody), true);
check('a build failure surfaces a status message instead of silently doing nothing', /statusEl\.textContent/.test(confirmBody), true);
check('the picker overlay is removed only AFTER a successful build (not before, which would strand the user on failure)', confirmBody.indexOf('_buildHoursReportForDates') < confirmBody.lastIndexOf("getElementById('hours-report-picker-overlay')"), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
