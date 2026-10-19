#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- get_employee_hours.
Moves date-range parsing BEFORE name resolution (it already existed,
just after the lookup) so the lookup can use the earliest requested
date -- a terminated employee must still resolve by name for a date
before she left. Not-found now checks _claireTerminatedExplanation for
a plain "she was terminated on X" message instead of a generic
employee_not_found. A multi-day range that extends past her
termination gets a per-day guard so days on/after that date report
"terminated", not a stale/misleading GPS-team fallthrough.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  } else if (name === 'get_employee_hours') {
    var ghLookup = findEmployeeWithSuggestions(input.employee || '');
    if (ghLookup.matches.length > 1) {
      _claireLastToolResult = JSON.stringify({
        error: 'ambiguous_employee', query: input.employee,
        candidates: ghLookup.matches.slice(0, 5).map(function(e){ return { name: e.name, id: e.id }; })
      });
      return;
    }
    if (ghLookup.matches.length === 0) {
      _claireLastToolResult = JSON.stringify({
        error: 'employee_not_found', query: input.employee,
        suggestions: ghLookup.suggestions.map(function(e){ return e.name; })
      });
      return;
    }
    var ghEmp = ghLookup.matches[0];
    var ghKeyId = ghEmp.legacy_roster_id || ghEmp.id;
    var ghDates = [];
    if (input.from && input.to) {
      var _ghCur = new Date(input.from + 'T00:00:00');
      var _ghEnd = new Date(input.to + 'T00:00:00');
      if (_ghEnd < _ghCur) { var _ghTmp = _ghCur; _ghCur = _ghEnd; _ghEnd = _ghTmp; } // forgiving of reversed inputs
      var _ghGuard = 0;
      while (_ghCur <= _ghEnd && _ghGuard < 366) {
        ghDates.push(dateKey(_ghCur));
        _ghCur = new Date(_ghCur.getTime() + 86400000);
        _ghGuard++;
      }
    } else {
      ghDates = [input.date || dateKey(new Date())];
    }
    var ghResults = [];
    for (var ghi = 0; ghi < ghDates.length; ghi++) {
      var ghDate = ghDates[ghi];
      var ghDayLabel = new Date(ghDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

      // Salaried Admin/Office (follow-up to migration 113). Checked
      // BEFORE the plain (hourly) Admin/Office branch right below --
      // no hours are ever tracked for a salaried employee, so there's
      // no override/GPS distinction to make at all.
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(ghEmp)) {
        ghResults.push({ date: ghDate, day_of_week: ghDayLabel, status: 'salaried', reason: ghEmp.name + ' is salaried, no hours tracked.' });
        continue;
      }
"""

NEW = """  } else if (name === 'get_employee_hours') {
    // Terminated-employee date-awareness fix: parse the requested date
    // range FIRST (this used to run after the lookup below) so name
    // resolution can use the EARLIEST date in it -- a terminated
    // employee must still resolve by name for a date before she left.
    var ghDates = [];
    if (input.from && input.to) {
      var _ghCur = new Date(input.from + 'T00:00:00');
      var _ghEnd = new Date(input.to + 'T00:00:00');
      if (_ghEnd < _ghCur) { var _ghTmp = _ghCur; _ghCur = _ghEnd; _ghEnd = _ghTmp; } // forgiving of reversed inputs
      var _ghGuard = 0;
      while (_ghCur <= _ghEnd && _ghGuard < 366) {
        ghDates.push(dateKey(_ghCur));
        _ghCur = new Date(_ghCur.getTime() + 86400000);
        _ghGuard++;
      }
    } else {
      ghDates = [input.date || dateKey(new Date())];
    }
    var ghLookupDate = ghDates[0];
    var ghLookup = findEmployeeWithSuggestions(input.employee || '', ghLookupDate);
    if (ghLookup.matches.length > 1) {
      _claireLastToolResult = JSON.stringify({
        error: 'ambiguous_employee', query: input.employee,
        candidates: ghLookup.matches.slice(0, 5).map(function(e){ return { name: e.name, id: e.id }; })
      });
      return;
    }
    if (ghLookup.matches.length === 0) {
      // Terminated-employee date-awareness fix: a plain, specific
      // explanation when the name belongs to someone terminated by
      // ghLookupDate, instead of a generic not-found.
      var ghTermExp = _claireTerminatedExplanation(input.employee || '', ghLookupDate);
      if (ghTermExp) {
        _claireLastToolResult = JSON.stringify({
          error: 'employee_terminated', query: input.employee, terminated_at: ghTermExp.terminated_at,
          message: ghTermExp.name + ' was terminated on ' + _pentaFormatDateOnly(ghTermExp.terminated_at) + ' -- there\\'s nothing to report after that date.'
        });
        return;
      }
      _claireLastToolResult = JSON.stringify({
        error: 'employee_not_found', query: input.employee,
        suggestions: ghLookup.suggestions.map(function(e){ return e.name; })
      });
      return;
    }
    var ghEmp = ghLookup.matches[0];
    var ghKeyId = ghEmp.legacy_roster_id || ghEmp.id;
    var ghResults = [];
    for (var ghi = 0; ghi < ghDates.length; ghi++) {
      var ghDate = ghDates[ghi];
      var ghDayLabel = new Date(ghDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

      // Terminated-employee date-awareness fix: a multi-day range can
      // extend past her termination even though ghLookupDate (the
      // range's first day) resolved her fine -- guard each day
      // individually so a day on/after her exclusion date reports
      // "terminated" plainly instead of falling through to a stale/
      // misleading GPS-team lookup (getEmployeeTeam already resolves
      // null for her on these days, which would otherwise misreport as
      // a plain "off" day with no explanation).
      if (_employeeExcludedAsOf(ghEmp, ghDate)) {
        ghResults.push({ date: ghDate, day_of_week: ghDayLabel, status: 'terminated', reason: ghEmp.name + ' was terminated on ' + _pentaFormatDateOnly(ghEmp.terminated_at) + '.' });
        continue;
      }

      // Salaried Admin/Office (follow-up to migration 113). Checked
      // BEFORE the plain (hourly) Admin/Office branch right below --
      // no hours are ever tracked for a salaried employee, so there's
      // no override/GPS distinction to make at all.
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(ghEmp)) {
        ghResults.push({ date: ghDate, day_of_week: ghDayLabel, status: 'salaried', reason: ghEmp.name + ' is salaried, no hours tracked.' });
        continue;
      }
"""

EDITS = [("get_employee_hours: date-aware lookup + per-day termination guard", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
