#!/usr/bin/env python3
"""Published Hours feature. A real employee login whose employees.
auth_user_id link is missing or broken would otherwise pass every
existing check (her app-level facade uuid still resolves fine via
legacy_roster_id) and then simply match zero published_employee_hours
rows forever under RLS -- indistinguishable from "nothing published
yet". Confirmed live via a read-only query: 20 of Manna's 25 active
employees have no auth_user_id at all today (most haven't been invited
to the new auth system yet). Reuses the existing _empUserId() resolver
(index.html, written for the same auth_user_id<->users.id resolution
elsewhere) instead of a second copy of that lookup. Skipped during
"Preview as employee" (detected via #pentaPreviewChip) -- there the
real Supabase session is the MANAGER's own, so an unlinked employee is
the normal, expected case, not an error.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    if (!_sb || !_bid || !_myUuid) throw new Error('Not connected -- cannot load published hours.');

    var _phMon = dateKey(days[0]), _phFri = dateKey(days[4]);"""

NEW = """    if (!_sb || !_bid || !_myUuid) throw new Error('Not connected -- cannot load published hours.');

    // Published Hours: distinguish "not linked to a login account" from
    // "nothing published yet" -- see this edit's own file header comment.
    var _isPreviewSession = !!document.getElementById('pentaPreviewChip');
    if (!_isPreviewSession) {
      var _authLinkId = (typeof _empUserId === 'function')
        ? await _empUserId(currentEmployee, _sb)
        : ((currentEmployee && currentEmployee.auth_user_id) || null);
      if (!_authLinkId) {
        if (_hoursBreakdownEl) _hoursBreakdownEl.innerHTML = '<div style="color:var(--red);text-align:center;padding:16px 0;font-size:13px">Your account is not linked to your employee record. Contact the office.</div>';
        return;
      }
    }

    var _phMon = dateKey(days[0]), _phFri = dateKey(days[4]);"""

EDITS = [("Portal renderHours: distinct message when the employee's auth link is missing", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
