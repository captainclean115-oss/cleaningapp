// Rule: the Team Hours modal's GPS activity timeline must REUSE the
// Live tab's existing activity-list renderer -- not write a second copy.
// _buildGpsStopList (stop construction) and _renderGPSStopRow (per-stop
// render, including the "Not lunch"/"Mark as lunch" toggle) were
// extracted out of renderGPS's old per-vehicle closure into shared,
// top-level functions specifically so both callers run the exact same
// code. This test proves that at the source level: each shared function
// is defined exactly once (not duplicated under a different name), and
// every real caller -- Live's renderGPS, and the modal's
// _teamHoursRenderGpsTimeline/_fetchTeamDayGpsDetail -- actually calls
// the shared function rather than its own inline reimplementation.
//
// Deliberately a source-text test, not an execution test: renderGPS
// itself depends on a large amount of Live-tab-only state (gpsVehicles,
// Leaflet/initMap, the map DOM) that isn't worth standing up just to
// prove two functions call each other -- grepping the real file for the
// call sites is a direct, honest check of the actual shared-code
// property this rule is about.
//
// Run with: node tests/team-hours-gps-timeline-shared-renderer.test.js

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

function countDefinitions(fnName) {
  // Matches `function _foo(` or `async function _foo(` as a definition
  // (not a call) -- a call site never has the `function` keyword
  // directly before the name.
  const re = new RegExp('(^|\\n)\\s*(async\\s+)?function\\s+' + fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g');
  return (src.match(re) || []).length;
}

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

// ---- Each shared function is defined exactly once ----
check('_buildGpsStopList is defined exactly once (no second copy)', countDefinitions('_buildGpsStopList'), 1);
check('_renderGPSStopRow is defined exactly once (no second copy)', countDefinitions('_renderGPSStopRow'), 1);
check('_computeGpsHoursFromTrips is defined exactly once', countDefinitions('_computeGpsHoursFromTrips'), 1);
check('_fetchTeamDayGpsDetail is defined exactly once', countDefinitions('_fetchTeamDayGpsDetail'), 1);

// ---- Live's renderGPS calls the shared functions (not an inline copy) ----
const renderGPSSrc = extract('function renderGPS() {', '\nfunction toggleGPSCard(id) {', 'renderGPS');
check('renderGPS builds its stop list via the shared _buildGpsStopList(...)', /_buildGpsStopList\(/.test(renderGPSSrc), true);
check('renderGPS renders each stop via the shared _renderGPSStopRow(...)', /_renderGPSStopRow\(/.test(renderGPSSrc), true);
// The old inline construction (synthetic first-stop push, per-trip
// stopList.push) must actually be GONE from renderGPS, not just
// additionally present alongside a new shared call -- otherwise this
// would be "wrote a second copy AND also calls the shared one",
// which is exactly the duplication rule #1 forbids.
check('renderGPS no longer builds its OWN stopList.push(...) construction inline', /stopList\.push\(/.test(renderGPSSrc), false);

// ---- The Team Hours modal's timeline uses the SAME shared renderer ----
const timelineSrc = extract('function _teamHoursRenderGpsTimeline(detail, team, dateStr) {', '\nasync function _teamHoursAfterLunchToggle', '_teamHoursRenderGpsTimeline');
check('_teamHoursRenderGpsTimeline renders stops via the shared _renderGPSStopRow(...)', /_renderGPSStopRow\(/.test(timelineSrc), true);

const fetchDetailSrc = extract('async function _fetchTeamDayGpsDetail(team, dateStr) {', '\n\nasync function showArchivedOverridesComparison', '_fetchTeamDayGpsDetail');
check('_fetchTeamDayGpsDetail builds its stop list via the shared _buildGpsStopList(...)', /_buildGpsStopList\(/.test(fetchDetailSrc), true);

// ---- _computeGpsHoursForDay (existing callers: Claire tools,
// showArchivedOverridesComparison) now goes through the same single
// fetch the modal uses, instead of its own separate Geotab round-trip ----
const gpsHoursForDaySrc = extract('async function _computeGpsHoursForDay(team, dateStr) {', '\n\n// Pure (no I/O)', '_computeGpsHoursForDay');
check('_computeGpsHoursForDay delegates to the shared _fetchTeamDayGpsDetail(...) instead of fetching its own trips', /_fetchTeamDayGpsDetail\(/.test(gpsHoursForDaySrc), true);

// ---- "Not lunch" inside the modal writes through the SAME function
// Live uses (lunch_flag_overrides, team-scoped, that date) -- not a
// second writer. _toggleLunchOverride's optional 7th param is how the
// modal hooks its own refresh on afterward, without forking the write
// itself. ----
check('_toggleLunchOverride (the shared lunch-flag writer) is defined exactly once', countDefinitions('_toggleLunchOverride'), 1);
check("_renderGPSStopRow's generated \"Not lunch\"/\"Mark as lunch\" buttons call the shared _toggleLunchOverride(...)",
  /onclick="event\.stopPropagation\(\);_toggleLunchOverride\(/.test(src), true);
// Live's own call sites must still omit the 7th arg (unaffected) --
// only ctx.afterToggleFn (passed by the modal) adds it.
const toggleOverrideDef = extract('async function _toggleLunchOverride(team, dateStr, stopKey, action, addr, durationMin, afterRefreshFn) {', '\n\n// PR #114', '_toggleLunchOverride');
check('_toggleLunchOverride\'s afterRefreshFn param is optional (Live\'s calls can omit it, unaffected)', /afterRefreshFn\s*&&/.test(toggleOverrideDef), true);
check('_toggleLunchOverride still always runs renderGPS() regardless (Live\'s own existing behavior, unchanged)', /if \(typeof renderGPS === 'function'\) renderGPS\(\);/.test(toggleOverrideDef), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
