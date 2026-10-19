#!/usr/bin/env python3
"""Published Hours feature. Realtime subscription (scoped to this one
employee's own rows -- same postgres_changes + filter pattern already
used throughout this file, e.g. PentaSettings._setupRealtime) and the
"Updated [date time]" label renderHours()'s published-hours read calls.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function renderHours() {"""

NEW = """// Published Hours -- realtime, scoped to ONE employee's own rows only
// (employee_id=eq.<uuid> filter), same pattern as PentaSettings/
// PentaAssignments/PentaChatMessages's own _setupRealtime elsewhere in
// this file. Re-renders the portal Hours screen on any change to her own
// published rows so a manager's "Publish now" (or the automatic
// publish cycle) shows up without the employee reloading. If the
// subscribe call itself fails (offline, etc.) this is non-fatal --
// renderHours() already re-fetches fresh on every tab-open/week-nav, and
// the portal's existing pull-to-refresh covers the rest.
var _publishedHoursRealtimeChannel = null;
var _publishedHoursRealtimeEmpId = null;
function _setupPublishedHoursRealtime(empUuid) {
  try {
    if (_publishedHoursRealtimeEmpId === empUuid && _publishedHoursRealtimeChannel) return;
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb || !empUuid) return;
    if (_publishedHoursRealtimeChannel) { try { sb.removeChannel(_publishedHoursRealtimeChannel); } catch (e) {} }
    _publishedHoursRealtimeEmpId = empUuid;
    _publishedHoursRealtimeChannel = sb.channel('penta-published-hours-' + empUuid)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'published_employee_hours', filter: 'employee_id=eq.' + empUuid },
        function () { try { renderHours(); } catch (e) { console.warn('[portal hours] realtime re-render failed', e); } })
      .subscribe(function (status) { console.log('[PublishedHours realtime] status=' + status); });
  } catch (e) { console.warn('[portal hours] realtime subscribe failed (non-fatal -- falls back to refresh-on-open/pull-to-refresh)', e); }
}

function _renderPortalHoursUpdatedLabel(publishedAtIso) {
  var el = document.getElementById('portal-hours-updated');
  if (!el) return;
  if (!publishedAtIso) { el.textContent = ''; return; }
  try {
    var d = new Date(publishedAtIso);
    el.textContent = 'Updated ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { el.textContent = ''; }
}

async function renderHours() {"""

EDITS = [("Portal: realtime subscription + Updated-label helpers for published hours", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
