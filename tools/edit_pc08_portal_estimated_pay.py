#!/usr/bin/env python3
"""Payroll cost tally feature. Employee portal: "Estimated gross pay
this week" line. Reads ONLY her own published rows (same query the
Hours screen already runs, extended to also select est_gross) -- never
touches employees.pay_rate, never shows the rate itself, employer
taxes, or anyone else's pay. Gated by businesses.show_estimated_pay_to_
employees (default OFF), which an employee session can already read
(no new RLS surface -- see migration 117's own comment on why that flag
lives on businesses, not business_payroll_settings).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    var _phMon = dateKey(days[0]), _phFri = dateKey(days[4]);
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
    _setupPublishedHoursRealtime(_myUuid);"""

NEW = """    var _phMon = dateKey(days[0]), _phFri = dateKey(days[4]);
    var _phRes = await _sb.from('published_employee_hours')
      .select('work_date, hours, start_time, end_time, lunch_minutes, status, published_at, est_gross')
      .eq('employee_id', _myUuid)
      .gte('work_date', _phMon)
      .lte('work_date', _phFri);
    if (_phRes.error) throw _phRes.error;

    var _phByDate = {};
    (_phRes.data || []).forEach(function (row) { _phByDate[row.work_date] = row; });

    var _todayKey = dateKey(new Date());
    var _maxPublishedAt = null;
    var _estGrossCentsSoFar = 0;
    var _anyDayIncomplete = false;
    days.forEach(function (d, i) {
      var dk = dateKey(d);
      var row = _phByDate[dk];
      if (row && row.published_at && (!_maxPublishedAt || row.published_at > _maxPublishedAt)) _maxPublishedAt = row.published_at;

      if (!row) {
        _anyDayIncomplete = true;
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
      if (row.status === 'worked' && row.est_gross != null) _estGrossCentsSoFar += row.est_gross;
    });
    composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);

    _renderPortalHoursUpdatedLabel(_maxPublishedAt);
    _renderPortalEstimatedPay(_estGrossCentsSoFar, _anyDayIncomplete);
    _setupPublishedHoursRealtime(_myUuid);"""

EDITS = [("Portal: sum est_gross across her own published worked days", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
