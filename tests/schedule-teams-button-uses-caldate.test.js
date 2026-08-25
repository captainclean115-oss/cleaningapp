// PR #145 — regression test for the Schedule tab's "👥 Teams" button
// opening Team Manager pre-set to TODAY instead of the date the schedule
// board was actually showing (calDate).
//
// Root cause of "PR #139's live duration recalc doesn't work": the button
// called openTeamManager() bare, so picker.value defaulted to today
// regardless of what day Tom was viewing. Any team change made from that
// modal wrote to today's dailyAssignments key while _refreshCalIfActive()
// correctly (and uselessly) re-rendered calDate -- a write to one date,
// a recalc of another. The Live tab's own Teams button already passed its
// own date correctly (openTeamManager(document.getElementById('gps-date-picker').value))
// -- only the Schedule tab's button had the gap.
//
// This can't be extracted/run via vm (it's a static HTML attribute, not a
// function), so this test just asserts the literal button markup wires the
// date through -- cheap enough to run on every change to guard the fix
// from silently regressing back to a bare call.
//
// Run with: node tests/schedule-teams-button-uses-caldate.test.js

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

const buttonMarker = '👥 Teams</button>';
const idx = src.indexOf(buttonMarker);
if (idx === -1) {
  console.error('FAIL: could not find the Schedule tab\'s Teams button in index.html — did it get refactored?');
  process.exit(1);
}
// Walk back to the start of that <button ...> tag.
const tagStart = src.lastIndexOf('<button', idx);
const buttonMarkup = src.slice(tagStart, idx + buttonMarker.length);

check(
  'the Schedule tab\'s Teams button passes the schedule board\'s own displayed date (calDate), not a bare call defaulting to today',
  /onclick="openTeamManager\(dateKey\(calDate\)\)"/.test(buttonMarkup),
  true
);
check(
  'the button is not calling openTeamManager() bare (the regressed/buggy form)',
  /onclick="openTeamManager\(\)"/.test(buttonMarkup),
  false
);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
