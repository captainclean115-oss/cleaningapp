#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- edit_employee_hours.
Moves the date default (input.date || today) BEFORE name resolution so
the lookup can use it -- a terminated employee must still resolve by
name for a date before she left. Not-found now checks
_claireTerminatedExplanation for a plain "no hours can be added after
that date" message. Since the SAME ehDate is both the lookup's asOfDate
and the date actually being edited, a successful match already
guarantees ehDate is before her termination (or she isn't terminated at
all) -- no separate per-edit guard needed beyond the lookup itself.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  } else if (name === 'edit_employee_hours') {
    var ehLookup = findEmployeeWithSuggestions(input.employee || '');
    if (ehLookup.matches.length > 1) {
      _claireLastToolResult = JSON.stringify({
        error: 'ambiguous_employee', query: input.employee,
        candidates: ehLookup.matches.slice(0, 5).map(function(e){ return { name: e.name, id: e.id }; })
      });
      return;
    }
    if (ehLookup.matches.length === 0) {
      _claireLastToolResult = JSON.stringify({
        error: 'employee_not_found', query: input.employee,
        suggestions: ehLookup.suggestions.map(function(e){ return e.name; })
      });
      return;
    }
    var ehEmp = ehLookup.matches[0];
    // Salaried Admin/Office (follow-up to migration 113): hard refusal
    // before any read/write -- there is nothing to edit.
    if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(ehEmp)) {
      var ehSalMsg = ehEmp.name + ' is salaried, so there are no hours to edit.';
      _claireLastToolResult = ehSalMsg;
      claireReply(message || ehSalMsg);
      return;
    }
    // PR #134 -- every empHrs_* reader/writer (renderHoursTable,
    // showEmpDayDetail, the employee portal) keys off getUnifiedRoster()
    // -style ids -- legacy_roster_id when the employee has one, which
    // matches production data 1:1 (documented in project memory as a
    // repeat trap: feedback_legacy_roster_id_vs_uuid_keyspace). Writing
    // under the Supabase uuid instead silently wrote to a key nothing
    // else ever read -- a live, confirmed bug, not a hypothetical one.
    var ehKeyId = ehEmp.legacy_roster_id || ehEmp.id;
    var ehDate = input.date || dateKey(new Date());
    var existing = getEmpHours(ehKeyId, ehDate) || {};"""

NEW = """  } else if (name === 'edit_employee_hours') {
    // Terminated-employee date-awareness fix: resolve the edit date
    // BEFORE name resolution (used to be computed after) so the lookup
    // can use it -- a terminated employee must still resolve by name
    // for a date before she left.
    var ehDate = input.date || dateKey(new Date());
    var ehLookup = findEmployeeWithSuggestions(input.employee || '', ehDate);
    if (ehLookup.matches.length > 1) {
      _claireLastToolResult = JSON.stringify({
        error: 'ambiguous_employee', query: input.employee,
        candidates: ehLookup.matches.slice(0, 5).map(function(e){ return { name: e.name, id: e.id }; })
      });
      return;
    }
    if (ehLookup.matches.length === 0) {
      // Terminated-employee date-awareness fix: a plain, specific
      // explanation when the name belongs to someone terminated by
      // ehDate, instead of a generic not-found.
      var ehTermExp = _claireTerminatedExplanation(input.employee || '', ehDate);
      if (ehTermExp) {
        var ehTermMsg = ehTermExp.name + ' was terminated on ' + _pentaFormatDateOnly(ehTermExp.terminated_at) + ', so no hours can be added after that date.';
        _claireLastToolResult = ehTermMsg;
        claireReply(message || ehTermMsg);
        return;
      }
      _claireLastToolResult = JSON.stringify({
        error: 'employee_not_found', query: input.employee,
        suggestions: ehLookup.suggestions.map(function(e){ return e.name; })
      });
      return;
    }
    var ehEmp = ehLookup.matches[0];
    // Salaried Admin/Office (follow-up to migration 113): hard refusal
    // before any read/write -- there is nothing to edit.
    if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(ehEmp)) {
      var ehSalMsg = ehEmp.name + ' is salaried, so there are no hours to edit.';
      _claireLastToolResult = ehSalMsg;
      claireReply(message || ehSalMsg);
      return;
    }
    // PR #134 -- every empHrs_* reader/writer (renderHoursTable,
    // showEmpDayDetail, the employee portal) keys off getUnifiedRoster()
    // -style ids -- legacy_roster_id when the employee has one, which
    // matches production data 1:1 (documented in project memory as a
    // repeat trap: feedback_legacy_roster_id_vs_uuid_keyspace). Writing
    // under the Supabase uuid instead silently wrote to a key nothing
    // else ever read -- a live, confirmed bug, not a hypothetical one.
    var ehKeyId = ehEmp.legacy_roster_id || ehEmp.id;
    var existing = getEmpHours(ehKeyId, ehDate) || {};"""

EDITS = [("edit_employee_hours: date-aware lookup + terminated explanation", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
