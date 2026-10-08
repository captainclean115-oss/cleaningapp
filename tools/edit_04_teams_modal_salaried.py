#!/usr/bin/env python3
"""Edit 4/N -- salaried Admin/Office feature.

Teams modal's Admin/Office section: a "Salaried" label next to the
employee's name. No hours/clock status is shown in this section today
for ANY admin employee (hourly or salaried) -- it only ever showed
name + Off badge + Off/Edit buttons -- so there's nothing hours-shaped
to additionally hide here; this is purely the label requirement.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "renderTeamManager Admin/Office section: Salaried label next to the employee's name",
        """            const _offInfo = _adminEmpDayOff(emp.id, dateStr);
            const _offBadge = _offInfo
              ? ('<span style="font-size:10px;color:var(--red);background:rgba(239,68,68,0.1);padding:1px 6px;border-radius:8px">🏖 ' + _adminEsc(_offInfo.label) + '</span>')
              : '';
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:14px">${_adminEsc(emp.name)} ${_offBadge}</span>""",
        """            const _offInfo = _adminEmpDayOff(emp.id, dateStr);
            const _offBadge = _offInfo
              ? ('<span style="font-size:10px;color:var(--red);background:rgba(239,68,68,0.1);padding:1px 6px;border-radius:8px">🏖 ' + _adminEsc(_offInfo.label) + '</span>')
              : '';
            const _salariedBadge = (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp))
              ? '<span style="font-size:10px;color:#fbbf24;font-weight:700;background:rgba(251,191,36,0.1);padding:1px 6px;border-radius:8px">Salaried</span>'
              : '';
            return `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
            <span style="font-size:14px">${_adminEsc(emp.name)} ${_salariedBadge} ${_offBadge}</span>""",
    ),
]

apply_edits(EDITS)
