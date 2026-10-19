#!/usr/bin/env python3
"""Portal-hours-match-manager fix -- the actual bug fix. The field-
employee branch of renderHours() used to read localStorage.getItem(
'weekHours_cache'/weekKey) and 'empHours_cache' -- a snapshot ONLY
ever written by a MANAGER's own loadWeekHours() call, on the manager's
own device (_writeWeekHoursCache's own comment: "Save per-employee
overrides into a format the portal can read"). A real employee's own
phone never runs loadWeekHours() (appUnlockEmployee only calls
renderHours()), so that snapshot was empty/stale/absent there, and
even on the SAME device (a manager's own "Preview as employee"), it
could be stale the instant a manual override was edited and the Hours
tab hadn't been reopened since.

Fix: call loadWeekHours() itself -- the SAME function the manager's
Hours table uses -- with hoursWeekOffset temporarily aligned to the
portal's own _portalWeekOffset, then read the result through
resolveEmployeeDayHours (edit_02/03), the SAME shared precedence
function renderHoursTable's own cells use. hoursWeekOffset is restored
afterward so a concurrent manager session is never left pointed at
the wrong week. On any failure, a visible error replaces the
breakdown -- never a blank or a zero that looks real.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  try {
    var weekData = _portalWeekOffset === 0
      ? localStorage.getItem('weekHours_cache')
      : localStorage.getItem(weekKey);
    var data = weekData ? JSON.parse(weekData) : null;

    if (data && currentEmployee && currentEmployee.id) {
      var _resolveTeamBlob = function (teamName) {
        if (!teamName) return null;
        if (data[teamName]) return data[teamName];
        // Sprint 6.10 aliasing, preserved: cache may be keyed under the
        // team's current PentaTeams-resolved name instead of the raw
        // team code.
        if (window.PentaTeams && typeof window.PentaTeams.getByName === 'function') {
          var pt = window.PentaTeams.getByName(teamName);
          if (pt && pt.name && data[pt.name]) return data[pt.name];
        }
        return null;
      };

      days.forEach(function (d, i) {
        var dk = dateKey(d);
        var dayTeam = (typeof getEmployeeTeam === 'function') ? getEmployeeTeam(currentEmployee.id, dk) : null;
        if (!dayTeam) {
          // PR #137 -- null here means an explicit OFF override (see
          // this block's declaration comment), not "no data." Match
          // renderHoursTable's own semantics: show the off status,
          // zero hours, no GPS fallback of any kind for this day.
          var offInfo = (typeof getEmployeeDayOffInfo === 'function') ? getEmployeeDayOffInfo(currentEmployee.id, dk) : null;
          var offType = offInfo && offInfo.status_type;
          composite.status[i] = {
            type: offType || 'off',
            label: (offType && typeof DAY_OFF_CATEGORY_LABELS !== 'undefined' && DAY_OFF_CATEGORY_LABELS[offType]) || 'Off'
          };
          return;
        }
        var dayBlob = _resolveTeamBlob(dayTeam);
        if (dayBlob) {
          composite.days[i] = (dayBlob.days && dayBlob.days[i]) || 0;
          composite.starts[i] = (dayBlob.starts && dayBlob.starts[i]) || null;
          composite.ends[i] = (dayBlob.ends && dayBlob.ends[i]) || null;
          composite.lunch[i] = (dayBlob.lunch && dayBlob.lunch[i]) || null;
        }
      });
      composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);

      // Check for per-employee overrides -- these win over the
      // team-aggregate GPS numbers above, same precedence
      // renderHoursTable's own override/teCell/team fallback chain uses.
      var empCache = JSON.parse(localStorage.getItem('empHours_cache') || '{}');
      var empOverrides = empCache[currentEmployee.id] || {};
      if (Object.keys(empOverrides).length > 0) {
        days.forEach(function(d, i) {
          var dk = dateKey(d);
          // PR #137 -- an OFF day (composite.status[i] set above) must
          // win unconditionally, matching renderHoursTable: that
          // function's OFF branch returns before override/teCell are
          // even read, so an OFF day is never reachable by a manual
          // hour override there either.
          if (composite.status[i]) return;
          if (empOverrides[dk]) {
            composite.days[i] = empOverrides[dk].hours || 0;
            if (empOverrides[dk].start) {
              var sp = empOverrides[dk].start.split(':');
              var sd = new Date(d); sd.setHours(parseInt(sp[0]),parseInt(sp[1]),0,0);
              composite.starts[i] = sd.toISOString();
            }
            if (empOverrides[dk].end) {
              var ep = empOverrides[dk].end.split(':');
              var ed = new Date(d); ed.setHours(parseInt(ep[0]),parseInt(ep[1]),0,0);
              composite.ends[i] = ed.toISOString();
            }
          }
        });
        composite.total = composite.days.reduce(function(s,h){ return s+(h||0); },0);
      }
    }
  } catch(e) {}

  renderHoursData(composite);
}"""

NEW = """  var _hoursBreakdownEl = document.getElementById('hours-breakdown');
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

  renderHoursData(composite);
}"""

EDITS = [("renderHours field-employee branch: compute live via loadWeekHours + resolveEmployeeDayHours", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
