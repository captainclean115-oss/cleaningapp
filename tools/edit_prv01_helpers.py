#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- adds the small formatting helpers
the resolver/summary code (next scripts in this sprint) builds on:
business-timezone-aware "today", 12-hour time display, a short weekday
date label, and a first-name+last-initial short name for one-line
proposal summaries.

Inserted right before findClients() -- the existing cluster of Claire
client/employee lookup helpers.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function findClients(query) {"""

NEW = """// Claire proposal-resolve-verify: business-timezone-aware "today" for
// every Claire date fallback. dateKey(new Date()) (used throughout the
// rest of the app) is DEVICE-local-time -- fine for a manager glancing
// at their own device's calendar, but wrong for Claire: she must agree
// with the BUSINESS's own configured timezone (businesses.timezone),
// not whatever timezone a given phone happens to be set to, so a
// request near midnight resolves to the same calendar day the
// business's own schedule data uses.
function _claireTodayKey() {
  var p = _bizTodayParts(_pentaBusinessTimezone());
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

// 12-hour "9:00 AM" display for a "HH:MM"/"HH:MM:SS" time string.
function _claireTimeDisplay(hhmm) {
  if (!hhmm) return '';
  var tp = String(hhmm).split(':');
  var hr = parseInt(tp[0], 10), mn = parseInt(tp[1] || '0', 10);
  if (isNaN(hr)) return '';
  return (hr % 12 || 12) + ':' + (mn < 10 ? '0' : '') + mn + ' ' + (hr >= 12 ? 'PM' : 'AM');
}

// "Wed, Nov 11" weekday+month+day label for a YYYY-MM-DD date key.
function _claireDayLabel(dk) {
  if (!dk) return '';
  return new Date(dk + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// First name + last initial -- enough to tell "Lisa F." apart from any
// other client sharing her first name, without putting a full last
// name on a one-line proposal summary.
function _claireShortName(c) {
  if (!c) return 'that client';
  var fn = (c.fn || '').trim();
  var li = c.ln ? (String(c.ln).trim().charAt(0) + '.') : '';
  return (fn + ' ' + li).trim() || 'that client';
}

function findClients(query) {"""

EDITS = [("Claire proposal-resolve-verify: today/time/date/name formatting helpers", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
