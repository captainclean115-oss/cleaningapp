#!/usr/bin/env python3
"""Edit 5/N -- salaried Admin/Office feature.

Live Hours tab's Admin/Office group (renderHoursTable): a salaried
admin employee gets a "Salaried" row with NO day-cell grid at all (no
hours, no clock status, nothing to expand) and contributes 0 to
adminTotal -- the early return below never reaches the
`adminTotal += empWeekTotal` line, so this isn't a separate "set to
zero" step, it structurally can't contribute anything.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "renderHoursTable Admin/Office group: salaried branch, no day cells, no total contribution",
        """      const adminRowsHtml = adminEmployees.map(emp => {
        let empWeekTotal = 0;
        const dayCells = days.map(function(d, i) {""",
        """      const adminRowsHtml = adminEmployees.map(emp => {
        // Salaried Admin/Office: no hours entry, no clock status, never
        // counts toward any total -- return BEFORE building any day
        // cells or touching empWeekTotal/adminTotal at all, so there's
        // nothing to zero out after the fact, just nothing added in
        // the first place. Existing manual_hour_overrides rows (if any
        // survive from before this employee became salaried) are
        // deliberately left alone -- never read here, never deleted.
        if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
          const salInitial = (emp.name || '?').trim().charAt(0).toUpperCase();
          return '<div class="hrs-emp-row-wrap" id="hrs-emp-wrap-' + emp.id + '">'
            + '<div class="hrs-emp-row">'
            + '<div class="hrs-emp-avatar" style="background:#6c8fff">' + _audEsc(salInitial) + '</div>'
            + '<div class="hrs-emp-info">'
            + '<div class="hrs-emp-name">' + _audEsc(emp.name) + '</div>'
            + '<div class="hrs-emp-sub" style="color:#fbbf24">Salaried — no hours tracked</div>'
            + '</div>'
            + '<div class="hrs-emp-right">'
            + '<div class="hrs-emp-total" style="color:#fbbf24;font-size:12px;font-weight:600;background:none">Salaried</div>'
            + '</div></div>'
            + '</div>';
        }
        let empWeekTotal = 0;
        const dayCells = days.map(function(d, i) {""",
    ),
]

apply_edits(EDITS)
