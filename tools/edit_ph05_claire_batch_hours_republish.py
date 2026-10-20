#!/usr/bin/env python3
"""Published Hours feature. Same gap as edit_employee_hours, for the
batch tool: group every distinct date actually written in this batch and
republish each affected week once (deduped internally by
_republishAfterHoursEdit's own offset grouping).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    var beDayList = beApplied.map(function(r) { return r.employee.name + ' (' + r.date + ')'; }).join(', ');
    _claireLastToolResult = JSON.stringify({ success: true, count: beApplied.length, updated: beApplied.map(function(r){ return { employee: r.employee.name, date: r.date }; }) });"""

NEW = """    var beDayList = beApplied.map(function(r) { return r.employee.name + ' (' + r.date + ')'; }).join(', ');
    // Published Hours: none of these writes went through loadWeekHours()
    // on their own -- republish every distinct date this batch actually
    // touched (grouped by week internally) so the batch reaches the
    // employee-facing published table without waiting on an unrelated
    // later refresh.
    if (typeof _republishAfterHoursEdit === 'function') {
      _republishAfterHoursEdit(beApplied.map(function (r) { return r.date; })).catch(function (e) { console.error('[publish] Claire batch_edit_employee_hours republish failed', e); });
    }
    _claireLastToolResult = JSON.stringify({ success: true, count: beApplied.length, updated: beApplied.map(function(r){ return { employee: r.employee.name, date: r.date }; }) });"""

EDITS = [("Claire batch_edit_employee_hours: republish every distinct date written", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
