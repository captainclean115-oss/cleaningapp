#!/usr/bin/env python3
"""Published Hours feature. The ONE automatic publish trigger: every
successful loadWeekHours() run (manager tab load, week-nav, the 60s Live
timer, saveEmpDayHours/clearEmpDayHours's own unconditional post-save
call) schedules a debounced publish of exactly the week it just computed.
weekHours/window._empHoursMap are captured into local consts right here
-- loadWeekHours() always REASSIGNS these globals to a fresh object on
its next run rather than mutating in place (confirmed: `weekHours = {};`
at this function's own top), so a captured reference stays valid and
correct even if a newer call starts before the debounced publish fires.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    loadLunchEdits();
    _reconcileHoursWithLunch();
    _writeWeekHoursCache(days);

    renderHoursTable(days, DAYS_SHORT);

  } catch(e) {"""

NEW = """    loadLunchEdits();
    _reconcileHoursWithLunch();
    _writeWeekHoursCache(days);

    renderHoursTable(days, DAYS_SHORT);

    // Published Hours -- schedule a debounced publish of exactly what
    // was just rendered. Captured now (not re-read when the debounce
    // timer fires) so a newer loadWeekHours() call for a different week,
    // started before this timer fires, can never cause the wrong week's
    // data to be published under this week's key.
    try { _schedulePublishWeekHours(days, weekHours, window._empHoursMap); }
    catch (e) { console.warn('[publish] could not schedule auto-publish', e); }

  } catch(e) {"""

EDITS = [("_loadWeekHoursInner: schedule debounced auto-publish after every successful run", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
