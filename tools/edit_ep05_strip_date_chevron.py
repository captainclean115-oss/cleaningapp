#!/usr/bin/env python3
"""Employee portal polish, step 5: strip the ' ▾' chevron from every
place that SETS #portal-date's text -- the element is no longer a
button (step 4), and this stays true even if PORTAL_TABS_COMING_SOON
is later emptied and Schedule is re-enabled (the date must stay
display-only "on Schedule (when re-enabled)" too, per spec)."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

apply_edits([
    (
        "strip chevron: portal-date set #1",
        "  const dateEl = document.getElementById('portal-date');\n"
        "  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' ▾';",
        "  const dateEl = document.getElementById('portal-date');\n"
        "  // Employee portal polish: display-only -- no chevron, not tappable.\n"
        "  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });",
    ),
    (
        "strip chevron: portal-date set #2",
        "  document.getElementById('portal-date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' ▾';",
        "  // Employee portal polish: display-only -- no chevron, not tappable.\n"
        "  document.getElementById('portal-date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });",
    ),
    (
        "strip chevron: portal-date set #3 (schedule date-sync, dead while gated, but must stay display-only even once re-enabled)",
        "    portalDate.textContent = pdPrefix + viewDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' ▾';",
        "    // Employee portal polish: display-only -- no chevron, not tappable,\n"
        "    // even once Schedule is re-enabled (PORTAL_TABS_COMING_SOON emptied).\n"
        "    portalDate.textContent = pdPrefix + viewDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });",
    ),
])
