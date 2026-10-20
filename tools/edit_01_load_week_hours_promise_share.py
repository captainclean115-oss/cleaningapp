#!/usr/bin/env python3
"""Portal-hours-match-manager fix -- loadWeekHours() currently no-ops
silently if a load is already in flight (`if (_weekHoursLoadInFlight)
return;`), which any FIRE-AND-FORGET caller never noticed. The portal's
new fix (edit_03) needs to genuinely AWAIT the real computation
finishing before reading weekHours/_empHoursMap, including when a
concurrent call is already running (e.g. the manager's own 60s
Live-tab poll, in the same browser tab as a "Preview as employee"
session). Sharing the in-flight promise makes every caller -- old and
new -- actually wait for the real result instead of racing a no-op;
this changes NOTHING about the computed numbers themselves, only
makes concurrent callers correctly see the finished result instead of
silently getting nothing.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """var _weekHoursLoadInFlight = false;
async function loadWeekHours() {
  if (_weekHoursLoadInFlight) return;
  _weekHoursLoadInFlight = true;
  try {
    await _loadWeekHoursInner();
  } finally {
    _weekHoursLoadInFlight = false;
  }
}"""

NEW = """var _weekHoursLoadInFlight = false;
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

EDITS = [("loadWeekHours: share the in-flight promise instead of silently no-op'ing", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
