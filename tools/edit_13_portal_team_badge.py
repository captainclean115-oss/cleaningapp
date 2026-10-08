#!/usr/bin/env python3
"""Edit 13/N -- salaried Admin/Office feature.

Found while checking every portal sub-element, not just renderHours():
appUnlockEmployee() sets a "team-badge" header element (visible on
EVERY portal tab, not just Hours) to emp.team || 'No team' -- for a
salaried Admin/Office employee that's literal team language ("No
team") the spec explicitly says must not show. Shows "Salaried"
instead for that combination; left unchanged for a plain (hourly)
Admin/Office employee, since that's outside this task's scope (only
admin+salaried is affected).
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "appUnlockEmployee: team-badge shows 'Salaried' instead of 'No team' for a salaried Admin/Office employee",
        """  const badge = document.getElementById('team-badge');
  if (badge) {
    badge.textContent = emp.team || 'No team';
    badge.style.background = color + '22';
    badge.style.color = color;
    badge.style.border = '1px solid ' + color + '44';
  }""",
        """  const badge = document.getElementById('team-badge');
  if (badge) {
    // Salaried Admin/Office (follow-up to migration 113): "No team" is
    // literal team language the spec says a salaried employee must
    // never see -- this badge is visible on every portal tab, not just
    // Hours, so it needed its own fix separate from renderHours().
    if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
      badge.textContent = 'Salaried';
      badge.style.background = '#fbbf2422';
      badge.style.color = '#fbbf24';
      badge.style.border = '1px solid #fbbf2444';
    } else {
      badge.textContent = emp.team || 'No team';
      badge.style.background = color + '22';
      badge.style.color = color;
      badge.style.border = '1px solid ' + color + '44';
    }
  }""",
    ),
]

apply_edits(EDITS)
