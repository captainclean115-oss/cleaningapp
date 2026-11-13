#!/usr/bin/env python3
"""Hours-week-nav fix -- manager Hours tab.

Root cause (confirmed by reading the code, not guessed): hoursWeekMove()
updates hoursWeekOffset synchronously, but the label and the per-day data
only ever updated once the FULL load finished -- several readiness
awaits (PentaLunchFlags/PentaHourOverrides/PentaAssignments/PentaEmployees)
plus a Geotab/time_entries fetch. loadWeekHours()'s in-flight guard made
this worse: a tap that landed while a load was already running did NOT
start a new load for its own offset -- it just returned the SAME stale
promise. The one in-flight call would eventually read whatever
hoursWeekOffset happened to be by the time it got there (after several
more taps had already changed it), so it rendered a week nobody
individually tapped for -- exactly "tap Back, nothing happens; tap
again, it skips a week."

Fix:
1. hoursWeekMove() now updates the label and shows a loading placeholder
   INSTANTLY, synchronously, before any async work starts.
2. loadWeekHours() still never runs two overlapping Geotab/time_entries
   fetches (the original reason for the in-flight guard -- see
   _weekHoursLoadToken's own comment), but a tap landing mid-flight is
   never dropped: once the current load finishes, if hoursWeekOffset no
   longer matches what was actually rendered, it reruns immediately,
   under the SAME promise every existing awaited caller already relies on.
3. _loadWeekHoursInner captures hoursWeekOffset ONCE at the top and uses
   that captured value for everything in the function from then on
   (days, the label, the lunch-edit cache key) instead of re-reading the
   live global at scattered points, which could let the label, the
   lunch cache, and the rendered data each reflect a different week
   within the same call.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_STATE_AND_WRAPPER = """var _weekHoursLoadInFlight = false;
var _weekHoursLoadInFlightPromise = null;
// Portal-hours-match-manager fix: share the in-flight promise instead
// of silently no-op'ing a concurrent call. Every existing fire-and-
// forget caller (the button, the 60s timer, gpsInit()'s own initial
// call) is completely unaffected -- they never read the return value.
// Every AWAITED caller (including the portal's new live fetch) now
// correctly waits for the REAL result instead of racing a no-op that
// returned before the computation it was piggybacking on had finished.
async function loadWeekHours() {
  if (_weekHoursLoadInFlight) return _weekHoursLoadInFlightPromise;
  _weekHoursLoadInFlight = true;
  _weekHoursLoadInFlightPromise = (async function () {
    try {
      await _loadWeekHoursInner();
    } finally {
      _weekHoursLoadInFlight = false;
      _weekHoursLoadInFlightPromise = null;
    }
  })();
  return _weekHoursLoadInFlightPromise;
}"""

NEW_STATE_AND_WRAPPER = """var _weekHoursLoadInFlight = false;
var _weekHoursLoadInFlightPromise = null;
// Hours-week-nav fix: the offset _loadWeekHoursInner most recently
// attempted to render, set as soon as it captures hoursWeekOffset
// (before its own slow Geotab/time_entries fetch). loadWeekHours()
// below reruns the load whenever hoursWeekOffset has moved on from
// this since the last attempt started -- see that function's comment.
var _weekHoursLastAttemptedOffset = null;
// Portal-hours-match-manager fix: share the in-flight promise instead
// of silently no-op'ing a concurrent call. Every existing fire-and-
// forget caller (the button, the 60s timer, gpsInit()'s own initial
// call) is completely unaffected -- they never read the return value.
// Every AWAITED caller (including the portal's new live fetch) now
// correctly waits for the REAL result instead of racing a no-op that
// returned before the computation it was piggybacking on had finished.
//
// Hours-week-nav fix: still never runs two overlapping Geotab/
// time_entries fetches (the original reason this guard exists -- see
// _weekHoursLoadToken's own comment above), but a tap landing while a
// load is already in flight is never dropped either: the old code just
// returned the SAME stale promise with no new attempt for the new
// offset, so the one in-flight call would eventually read whatever
// hoursWeekOffset happened to be by the time it got there, landing on
// a week nobody individually tapped for ("tap Back, nothing happens;
// tap again, it skips a week"). Now, once a load finishes, if
// hoursWeekOffset no longer matches what it actually rendered, it
// reruns immediately -- as many times as it takes to catch up -- all
// under the SAME promise, so every existing awaited caller still sees
// the final, fully-settled, correct week.
async function loadWeekHours() {
  if (_weekHoursLoadInFlight) return _weekHoursLoadInFlightPromise;
  _weekHoursLoadInFlight = true;
  _weekHoursLoadInFlightPromise = (async function () {
    try {
      do {
        await _loadWeekHoursInner();
      } while (hoursWeekOffset !== _weekHoursLastAttemptedOffset);
    } finally {
      _weekHoursLoadInFlight = false;
      _weekHoursLoadInFlightPromise = null;
    }
  })();
  return _weekHoursLoadInFlightPromise;
}"""

OLD_HOURS_WEEK_MOVE = """function hoursWeekMove(dir) {
  hoursWeekOffset += dir;
  // Don't go into future
  if (hoursWeekOffset > 0) { hoursWeekOffset = 0; return; }
  loadWeekHours();
}"""

NEW_HOURS_WEEK_MOVE = """// Hours-week-nav fix: the one shared label-text formula, used both for
// instant tap feedback (hoursWeekMove, below) and inside
// _loadWeekHoursInner once the real data is in -- a single source so
// the label can never say one week while the table shows another.
function _hoursWeekLabelText(offset, days) {
  if (offset === 0) return 'This Week';
  if (offset === -1) return 'Last Week';
  days = days || getWeekDates(offset);
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var mon = days[0], fri = days[days.length - 1];
  return MONTHS[mon.getMonth()] + ' ' + mon.getDate() + ' – ' + MONTHS[fri.getMonth()] + ' ' + fri.getDate();
}

// Hours-week-nav fix: the label and a loading placeholder now update
// INSTANTLY on every tap, synchronously, before any async work starts
// -- the old code only updated them once the full load (several
// readiness awaits plus a Geotab/time_entries fetch) had finished, so
// a slow load made a tap look like it did nothing. The actual data
// fetch/render still happens inside loadWeekHours(), which is now safe
// against repeated fast taps (see that function's own comment).
function hoursWeekMove(dir) {
  hoursWeekOffset += dir;
  // Don't go into future
  if (hoursWeekOffset > 0) { hoursWeekOffset = 0; return; }
  var label = document.getElementById('hours-week-label');
  if (label) label.textContent = _hoursWeekLabelText(hoursWeekOffset);
  var table = document.getElementById('hours-table');
  if (table) table.innerHTML = '<div class="hours-loading">Loading hours...</div>';
  loadWeekHours();
}"""

OLD_INNER_TOP = """  const days = getWeekDates(hoursWeekOffset);
  const mon = days[0];
  const fri = days[days.length - 1];
  // Hours-weekend-days fix: derived from the real days array -- correct
  // length AND correct weekday order for a sunday-start business
  // (the old literal always started "Mon").
  const DAYS_SHORT = days.map(function (d) { return d.toLocaleDateString('en-US', { weekday: 'short' }); });
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Update week label
  const label = document.getElementById('hours-week-label');
  if (hoursWeekOffset === 0) {
    label.textContent = 'This Week';
  } else if (hoursWeekOffset === -1) {
    label.textContent = 'Last Week';
  } else {
    label.textContent = MONTHS[mon.getMonth()] + ' ' + mon.getDate() + ' – ' + MONTHS[fri.getMonth()] + ' ' + fri.getDate();
  }

  document.getElementById('hours-table').innerHTML = '<div class="hours-loading">Loading hours...</div>';"""

NEW_INNER_TOP = """  // Hours-week-nav fix: captured ONCE here and used for every read in
  // this function from this point on (days, the label, the lunch-edit
  // cache key) -- never hoursWeekOffset itself again, which can change
  // mid-flight if another tap lands while this load's own Geotab/
  // time_entries fetch is still pending. Reading the live global at
  // scattered points used to let the label, the lunch cache, and the
  // actually-rendered data each reflect a different week within the
  // same call.
  const _myHoursOffset = hoursWeekOffset;
  _weekHoursLastAttemptedOffset = _myHoursOffset;
  const days = getWeekDates(_myHoursOffset);
  // Hours-weekend-days fix: derived from the real days array -- correct
  // length AND correct weekday order for a sunday-start business
  // (the old literal always started "Mon").
  const DAYS_SHORT = days.map(function (d) { return d.toLocaleDateString('en-US', { weekday: 'short' }); });

  // Update week label -- hoursWeekMove() already set this instantly on
  // tap; this just re-confirms it (for every OTHER caller of
  // loadWeekHours too) once the real data is actually in.
  const label = document.getElementById('hours-week-label');
  if (label) label.textContent = _hoursWeekLabelText(_myHoursOffset, days);

  document.getElementById('hours-table').innerHTML = '<div class="hours-loading">Loading hours...</div>';"""

OLD_LOAD_LUNCH_EDITS_DEF = """function loadLunchEdits() {
  const edits = JSON.parse(localStorage.getItem('lunch_edits') || '{}');
  Object.keys(weekHours).forEach(team => {
    const key = hoursWeekOffset + '_' + team;"""

NEW_LOAD_LUNCH_EDITS_DEF = """function loadLunchEdits(offset) {
  // Hours-week-nav fix: an explicit offset (passed by
  // _loadWeekHoursInner, captured before its own slow fetch) always
  // wins over the live global, which can have moved on to a different
  // week by the time this runs. Other callers (none currently pass one)
  // keep reading the live global, unchanged.
  var _effOffset = (offset !== undefined) ? offset : hoursWeekOffset;
  const edits = JSON.parse(localStorage.getItem('lunch_edits') || '{}');
  Object.keys(weekHours).forEach(team => {
    const key = _effOffset + '_' + team;"""

OLD_LOAD_LUNCH_EDITS_CALL = """    loadLunchEdits();
    _reconcileHoursWithLunch();
    _writeWeekHoursCache(days);

    renderHoursTable(days, DAYS_SHORT);"""

NEW_LOAD_LUNCH_EDITS_CALL = """    loadLunchEdits(_myHoursOffset);
    _reconcileHoursWithLunch();
    _writeWeekHoursCache(days);

    renderHoursTable(days, DAYS_SHORT);"""

EDITS = [
    ("Hours-week-nav fix: loadWeekHours reruns instead of dropping a tap", OLD_STATE_AND_WRAPPER, NEW_STATE_AND_WRAPPER),
    ("Hours-week-nav fix: hoursWeekMove updates the label/loading state instantly", OLD_HOURS_WEEK_MOVE, NEW_HOURS_WEEK_MOVE),
    ("Hours-week-nav fix: _loadWeekHoursInner captures the offset once", OLD_INNER_TOP, NEW_INNER_TOP),
    ("Hours-week-nav fix: loadLunchEdits accepts an explicit offset", OLD_LOAD_LUNCH_EDITS_DEF, NEW_LOAD_LUNCH_EDITS_DEF),
    ("Hours-week-nav fix: pass the captured offset into loadLunchEdits", OLD_LOAD_LUNCH_EDITS_CALL, NEW_LOAD_LUNCH_EDITS_CALL),
]

if __name__ == "__main__":
    apply_edits(EDITS)
