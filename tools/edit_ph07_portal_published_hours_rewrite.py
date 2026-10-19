#!/usr/bin/env python3
"""Published Hours feature. The portal's field-employee branch no longer
calls loadWeekHours() at all -- it reads ONLY published_employee_hours,
filtered to this employee's own employee_id (RLS-enforced; this query
itself never asks for anyone else's row either). No Geotab call, no
whole-business manual_hour_overrides/daily_assignments hydration reaches
this device anymore. Realtime-subscribed to her own rows so a manager
publish shows up without a reload; falls back to refresh-on-open/pull-to-
refresh (both already exist) if realtime fails to connect.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  var _hoursBreakdownEl = document.getElementById('hours-breakdown');
  if (_hoursBreakdownEl) _hoursBreakdownEl.innerHTML = '<div style="color:var(--muted);text-align:center;padding:16px 0;font-size:13px">Loading your hours...</div>';

  try {
    // Portal-hours-match-manager fix: compute LIVE via the exact same
    // function the manager's Hours table uses, instead of reading a
    // stale, device-local localStorage snapshot that a real employee's
    // own phone never populated in the first place (that snapshot is
    // only ever written by a MANAGER's own loadWeekHours() call, on
    // the manager's own device). hoursWeekOffset is the manager's own
    // global week pointer -- temporarily align it to this portal's own
    // _portalWeekOffset, then restore it, so a concurrent manager
    // session (e.g. "Preview as employee", which runs in the very same
    // browser tab) is never left pointed at the wrong week.
    var _savedHoursWeekOffset = (typeof hoursWeekOffset !== 'undefined') ? hoursWeekOffset : 0;
    try {
      hoursWeekOffset = _portalWeekOffset;
      await loadWeekHours();
    } finally {
      hoursWeekOffset = _savedHoursWeekOffset;
    }

    // weekHours/_empHoursMap are the SAME globals renderHoursTable
    // itself reads -- loadWeekHours() just finished populating them
    // fresh, for this employee's own week. Only HER slice is ever read
    // out (resolveEmployeeDayHours(currentEmployee.id, ...)) -- every
    // other employee's data loadWeekHours() computed along the way
    // stays in memory, never rendered here.
    var _liveWeekHours = (typeof weekHours !== 'undefined') ? weekHours : {};
    var _liveEmpHoursMap = (typeof window !== 'undefined' && window._empHoursMap) ? window._empHoursMap : {};

    if (currentEmployee && currentEmployee.id) {
      days.forEach(function (d, i) {
        var _rd = resolveEmployeeDayHours(currentEmployee.id, d, i, _liveWeekHours, _liveEmpHoursMap);
        if (_rd.isOff) {
          // PR #137 -- an explicit OFF override, not "no data." Match
          // renderHoursTable's own semantics: show the off status, zero
          // hours, no GPS fallback of any kind for this day.
          var offInfo = (typeof getEmployeeDayOffInfo === 'function') ? getEmployeeDayOffInfo(currentEmployee.id, dateKey(d)) : null;
          var offType = offInfo && offInfo.status_type;
          composite.status[i] = {
            type: offType || 'off',
            label: (offType && typeof DAY_OFF_CATEGORY_LABELS !== 'undefined' && DAY_OFF_CATEGORY_LABELS[offType]) || 'Off'
          };
          return;
        }
        composite.days[i] = _rd.hours || 0;
        composite.starts[i] = _rd.startDate ? _rd.startDate.toISOString() : null;
        composite.ends[i] = _rd.endDate ? _rd.endDate.toISOString() : null;
        composite.lunch[i] = _rd.lunchMin ? { duration: _rd.lunchMin } : null;
      });
      composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);
    }
  } catch (e) {
    // No silent early return: a failed live fetch must never fall back
    // to the stale cache this fix removes (that would silently
    // reintroduce the exact bug), and must never show a blank or a
    // zero that looks like a real answer.
    console.error('[portal hours] live hours computation failed', e);
    if (_hoursBreakdownEl) _hoursBreakdownEl.innerHTML = '<div style="color:var(--red);text-align:center;padding:16px 0;font-size:13px">Could not load your hours. Pull to refresh or try again.</div>';
    return;
  }

  renderHoursData(composite);"""

NEW = """  var _hoursBreakdownEl = document.getElementById('hours-breakdown');
  if (_hoursBreakdownEl) _hoursBreakdownEl.innerHTML = '<div style="color:var(--muted);text-align:center;padding:16px 0;font-size:13px">Loading your hours...</div>';

  try {
    // Published Hours: reads ONLY published_employee_hours, filtered to
    // THIS employee's own employee_id. No loadWeekHours(), no Geotab
    // call, no whole-business manual_hour_overrides/daily_assignments
    // fetch -- none of that reaches this device anymore (see
    // migrations/114_published_employee_hours.sql and this feature's PR
    // description for why the live-compute version this replaces did).
    var _sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    var _bid = (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null;
    var _myUuid = (currentEmployee && currentEmployee.uuid)
      || (currentEmployee && window.PentaEmployees && window.PentaEmployees.getByLegacyRosterId
          ? (function () { var r = window.PentaEmployees.getByLegacyRosterId(currentEmployee.id); return r && r.id; })()
          : null);
    if (!_sb || !_bid || !_myUuid) throw new Error('Not connected -- cannot load published hours.');

    var _phMon = dateKey(days[0]), _phFri = dateKey(days[4]);
    var _phRes = await _sb.from('published_employee_hours')
      .select('work_date, hours, start_time, end_time, lunch_minutes, status, published_at')
      .eq('employee_id', _myUuid)
      .gte('work_date', _phMon)
      .lte('work_date', _phFri);
    if (_phRes.error) throw _phRes.error;

    var _phByDate = {};
    (_phRes.data || []).forEach(function (row) { _phByDate[row.work_date] = row; });

    var _todayKey = dateKey(new Date());
    var _maxPublishedAt = null;
    days.forEach(function (d, i) {
      var dk = dateKey(d);
      var row = _phByDate[dk];
      if (row && row.published_at && (!_maxPublishedAt || row.published_at > _maxPublishedAt)) _maxPublishedAt = row.published_at;

      if (!row) {
        composite.status[i] = (dk === _todayKey)
          ? { type: 'in_progress', label: 'In progress, updates after your manager reviews' }
          : { type: 'not_published', label: 'Not updated yet' };
        return;
      }
      if (row.status === 'off' || row.status === 'vacation') {
        composite.status[i] = { type: row.status, label: (row.status === 'vacation' ? 'Vacation' : 'Off') };
        return;
      }
      composite.days[i] = row.hours || 0;
      composite.starts[i] = row.start_time || null;
      composite.ends[i] = row.end_time || null;
      composite.lunch[i] = row.lunch_minutes ? { duration: row.lunch_minutes } : null;
    });
    composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);

    _renderPortalHoursUpdatedLabel(_maxPublishedAt);
    _setupPublishedHoursRealtime(_myUuid);
  } catch (e) {
    // No silent early return, and never a blank/fake-zero on failure --
    // same contract as the live-fetch version this replaces.
    console.error('[portal hours] published hours fetch failed', e);
    if (_hoursBreakdownEl) _hoursBreakdownEl.innerHTML = '<div style="color:var(--red);text-align:center;padding:16px 0;font-size:13px">Could not load your hours. Pull to refresh or try again.</div>';
    return;
  }

  renderHoursData(composite);"""

EDITS = [("Portal renderHours: read published_employee_hours instead of computing live", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
