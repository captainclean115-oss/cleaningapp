// PR #141 — regression test for the Live tab's new "Teams" button.
// Requirement: identical to the Schedule tab's existing Teams button --
// same modal, same handler function, no duplicated code -- just passing
// the Live tab's own currently-selected date instead of defaulting to
// today (which is what the Schedule tab's button still does, unchanged).
//
// Checks structure (no duplicated modal/handler, both buttons share the
// same styling and call the same function) by inspecting the actual
// index.html source, then extracts the real openTeamManager() and runs
// it in a sandbox to prove both the no-arg default (Schedule tab,
// unchanged) and the explicit-date path (Live tab, new) work correctly.
//
// Run with: node tests/live-tab-teams-button.test.js

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

// --- No duplicated modal or handler ---
const teamManagerOverlayMatches = (src.match(/id="team-manager-overlay"/g) || []).length;
check('exactly one #team-manager-overlay modal exists (not duplicated for the Live tab)', teamManagerOverlayMatches, 1);

const openTeamManagerDefs = (src.match(/async function openTeamManager\(/g) || []).length;
check('exactly one openTeamManager() function definition exists (not duplicated)', openTeamManagerDefs, 1);

// --- Both buttons invoke the same function ---
const scheduleBtnMatch = src.match(/<button onclick="openTeamManager\(\)"[^>]*>👥 Teams<\/button>/);
check('Schedule tab button still calls bare openTeamManager() -- unchanged, no regression', !!scheduleBtnMatch, true);

const liveBtnMatch = src.match(/<button onclick="openTeamManager\(document\.getElementById\('gps-date-picker'\)\.value\)"[^>]*>👥 Teams<\/button>/);
check('Live tab button calls openTeamManager(...) with the Live tab\'s own date-picker value', !!liveBtnMatch, true);

// --- Same styling (visual consistency) ---
if (scheduleBtnMatch && liveBtnMatch) {
  const styleOf = (tag) => { const m = tag.match(/style="([^"]*)"/); return m ? m[1] : null; };
  check('both buttons use identical inline styling', styleOf(liveBtnMatch[0]), styleOf(scheduleBtnMatch[0]));
}

// --- Placement: between gps-main-section's close and hours-section's open ---
const gpsMainCloseIdx = src.indexOf('<div id="gps-vehicles"></div>');
const hoursSectionIdx = src.indexOf('<div id="hours-section"');
const liveBtnIdx = liveBtnMatch ? src.indexOf(liveBtnMatch[0]) : -1;
check(
  'Live tab button sits after the GPS/fleet section and before the Hours section',
  gpsMainCloseIdx !== -1 && hoursSectionIdx !== -1 && liveBtnIdx > gpsMainCloseIdx && liveBtnIdx < hoursSectionIdx,
  true
);

// --- Behavioral: openTeamManager's date handling, both call shapes ---
const fnStart = 'async function openTeamManager(dateStr) {';
const fnStartIdx = src.indexOf(fnStart);
if (fnStartIdx === -1) {
  console.error('FAIL: could not find openTeamManager(dateStr) in index.html — did its signature change?');
  process.exit(1);
}
const fnEndIdx = src.indexOf('\nfunction closeTeamManager()', fnStartIdx);
if (fnEndIdx === -1) {
  console.error('FAIL: could not find the end boundary after openTeamManager — extraction range may need updating.');
  process.exit(1);
}
const fnSource = src.slice(fnStartIdx, fnEndIdx);

function buildSandbox() {
  const overlay = { style: { display: '' } };
  const picker = { value: '' };
  const elements = { 'team-manager-overlay': overlay, 'team-mgr-date': picker };
  const sandbox = {
    console: console,
    document: { getElementById: function (id) { return elements[id] || null; } },
    renderTeamManager: function () {},
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return { sandbox: sandbox, overlay: overlay, picker: picker };
}

(async function () {
  // Schedule tab's call shape: no argument -- must default to today,
  // exactly its pre-existing behavior (no regression).
  {
    const { sandbox, overlay, picker } = buildSandbox();
    await sandbox.openTeamManager();
    const today = new Date().toISOString().split('T')[0];
    check('bare openTeamManager() (Schedule tab call shape) defaults to today', picker.value, today);
    check('bare openTeamManager() opens the overlay', overlay.style.display, 'flex');
  }

  // Live tab's call shape: an explicit date -- must be used as-is,
  // not overridden back to today.
  {
    const { sandbox, overlay, picker } = buildSandbox();
    await sandbox.openTeamManager('2026-08-18');
    check('openTeamManager(dateStr) (Live tab call shape) uses the passed date, not today', picker.value, '2026-08-18');
    check('openTeamManager(dateStr) opens the overlay', overlay.style.display, 'flex');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
