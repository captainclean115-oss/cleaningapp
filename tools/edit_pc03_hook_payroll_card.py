#!/usr/bin/env python3
"""Payroll cost tally feature. Hooks renderPayrollCostCard() into the
same render pass as the Hours table itself -- same globals it just
computed from, never a second calculation of hours.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    renderHoursTable(days, DAYS_SHORT);

    // Published Hours -- schedule a debounced publish of exactly what
    // was just rendered. Captured now (not re-read when the debounce
    // timer fires) so a newer loadWeekHours() call for a different week,
    // started before this timer fires, can never cause the wrong week's
    // data to be published under this week's key.
    try { _schedulePublishWeekHours(days, weekHours, window._empHoursMap); }
    catch (e) { console.warn('[publish] could not schedule auto-publish', e); }"""

NEW = """    renderHoursTable(days, DAYS_SHORT);

    // Payroll cost tally feature: same globals the Hours table itself
    // just rendered from -- never a second calculation of hours. Async
    // (fetches payroll settings) but not awaited here -- the Hours table
    // itself must not wait on it, same reasoning as the publish schedule
    // right below.
    try { renderPayrollCostCard(days, weekHours, window._empHoursMap); }
    catch (e) { console.warn('[payroll card] render call failed', e); }

    // Published Hours -- schedule a debounced publish of exactly what
    // was just rendered. Captured now (not re-read when the debounce
    // timer fires) so a newer loadWeekHours() call for a different week,
    // started before this timer fires, can never cause the wrong week's
    // data to be published under this week's key.
    try { _schedulePublishWeekHours(days, weekHours, window._empHoursMap); }
    catch (e) { console.warn('[publish] could not schedule auto-publish', e); }"""

EDITS = [("_loadWeekHoursInner: hook renderPayrollCostCard into the render pass", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
