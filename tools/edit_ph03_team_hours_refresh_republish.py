#!/usr/bin/env python3
"""Published Hours feature. _teamHoursRefreshAfterWrite previously only
called loadWeekHours() if the Live tab happened to be the active view AND
showing the edited date's week -- meaning a Team Hours modal edit (or the
lunch-toggle, same function) made while the manager is anywhere else in
the app never recomputed weekHours at all, so the new auto-publish hook
at loadWeekHours()'s own tail would never fire for that edit either.
Replaced with the unconditional _republishAfterHoursEdit(dateStr), which
realigns hoursWeekOffset to the edited date's own week, runs
loadWeekHours() there (triggering the auto-publish hook), then restores
whatever week the manager was actually looking at -- same align/restore
pattern already used by the portal in the prior PR on this branch.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function _teamHoursRefreshAfterWrite(dateStr) {
  try {
    if (typeof weekHours !== 'undefined' && typeof hoursWeekOffset !== 'undefined') {
      var gv = document.getElementById('gps-view');
      var days = getWeekDates(hoursWeekOffset);
      var d = new Date(dateStr + 'T00:00:00');
      var inView = days.length && d >= days[0] && d <= days[4];
      if (gv && gv.classList.contains('active') && inView && typeof loadWeekHours === 'function') {
        await loadWeekHours();
      }
    }
  } catch (e) {
    console.error('[TeamHours] post-write Live hours refresh failed (the save itself already succeeded)', e);
  }
  try {
    await renderTeamManager();
  } catch (e) {
    console.error('[TeamHours] post-write Team Manager re-render failed (the save itself already succeeded)', e);
  }
}"""

NEW = """async function _teamHoursRefreshAfterWrite(dateStr) {
  try {
    // Published Hours: was gated on the Live tab being the active view
    // AND showing this date's week -- a Team Hours edit made from
    // anywhere else in the app never recomputed weekHours, so the
    // employee-facing publish (hooked into loadWeekHours()'s own tail)
    // never fired for it either. Unconditional now; still restores
    // whatever week the manager was actually looking at afterward.
    if (typeof loadWeekHours === 'function') {
      await _republishAfterHoursEdit(dateStr);
    }
  } catch (e) {
    console.error('[TeamHours] post-write Live hours refresh failed (the save itself already succeeded)', e);
  }
  try {
    await renderTeamManager();
  } catch (e) {
    console.error('[TeamHours] post-write Team Manager re-render failed (the save itself already succeeded)', e);
  }
}"""

EDITS = [("_teamHoursRefreshAfterWrite: unconditional republish instead of gated loadWeekHours", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
