#!/usr/bin/env python3
"""Terminate flow fix (C) -- unassignFutureForEmployee must never
soft-delete a row dated today or earlier, even when the termination
date D is backdated into the past. Effective floor becomes
max(D, tomorrow) in business timezone: a future D still purges from D
itself (unchanged); a D that's today or in the past purges only
strictly-future rows, leaving every real day that already happened
(today included) untouched.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  // PR #149 — employee termination. Bulk version of unassign(): soft-deletes
  // every active assignment for one employee on/after fromDate, in one
  // query (not a loop over unassign() per date). Past assignments
  // (date < fromDate) are untouched -- the audit trail requirement from
  // the termination spec. Returns the count removed.
  async function unassignFutureForEmployee(employeeId, fromDate) {
    var sb = SB();
    if (!sb) throw new Error('PentaAssignments.unassignFutureForEmployee: no Supabase client');
    var dbEmpId = await _resolveEmployeeId(employeeId);
    if (!dbEmpId) return 0;
    var toRemove = _cache.filter(function(r){ return r.employee_id === dbEmpId && r.date >= fromDate; });
    if (!toRemove.length) return 0;
    var actorId = await _currentUserId();
    var nowIso = new Date().toISOString();
    var res = await sb.from('daily_assignments')
      .update({ deleted_at: nowIso, deleted_by: actorId })
      .eq('employee_id', dbEmpId).gte('date', fromDate).is('deleted_at', null);
    if (res.error) throw res.error;
    var removedIds = {};
    toRemove.forEach(function(r){ removedIds[r.id] = true; });
    _cache = _cache.filter(function(r){ return !removedIds[r.id]; });
    _rebuildIndex();
    _notify();
    return toRemove.length;
  }"""

NEW = """  // PR #149 — employee termination. Bulk version of unassign(): soft-deletes
  // every active assignment for one employee on/after fromDate, in one
  // query (not a loop over unassign() per date). Past assignments
  // (date < fromDate) are untouched -- the audit trail requirement from
  // the termination spec. Returns the count removed.
  //
  // Fix (terminated-employee date-awareness follow-up): fromDate (the
  // termination date D) is manager-entered with no min/max on the date
  // picker -- a backdated D used to mean "purge every real, already-
  // worked day between D and today" too, destroying genuine history.
  // The effective purge floor is now max(fromDate, tomorrow) in
  // business timezone: a FUTURE D still purges from D itself
  // (unchanged -- those days haven't happened yet, purging them early
  // is exactly the point); a D that's today or in the past purges only
  // STRICTLY future rows, leaving every day that already happened --
  // today included -- untouched no matter how far back D is set.
  async function unassignFutureForEmployee(employeeId, fromDate) {
    var sb = SB();
    if (!sb) throw new Error('PentaAssignments.unassignFutureForEmployee: no Supabase client');
    var dbEmpId = await _resolveEmployeeId(employeeId);
    if (!dbEmpId) return 0;
    var _tp = _bizTodayParts(_pentaBusinessTimezone());
    var _tomorrow = new Date(_tp.y, _tp.m - 1, _tp.d + 1);
    var _tomorrowKey = _tomorrow.getFullYear() + '-' + String(_tomorrow.getMonth() + 1).padStart(2, '0') + '-' + String(_tomorrow.getDate()).padStart(2, '0');
    var effectiveFloor = fromDate > _tomorrowKey ? fromDate : _tomorrowKey;
    var toRemove = _cache.filter(function(r){ return r.employee_id === dbEmpId && r.date >= effectiveFloor; });
    if (!toRemove.length) return 0;
    var actorId = await _currentUserId();
    var nowIso = new Date().toISOString();
    var res = await sb.from('daily_assignments')
      .update({ deleted_at: nowIso, deleted_by: actorId })
      .eq('employee_id', dbEmpId).gte('date', effectiveFloor).is('deleted_at', null);
    if (res.error) throw res.error;
    var removedIds = {};
    toRemove.forEach(function(r){ removedIds[r.id] = true; });
    _cache = _cache.filter(function(r){ return !removedIds[r.id]; });
    _rebuildIndex();
    _notify();
    return toRemove.length;
  }"""

EDITS = [("unassignFutureForEmployee: never purge today-or-earlier", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
