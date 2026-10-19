#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- batch_edit_employee_hours.
Moves the per-entry date default (beEnt.date || today) BEFORE name
resolution for THAT entry so the lookup can use it -- each entry
already carries its own date, so this is a pure reordering, no new
state. A not-found entry now checks _claireTerminatedExplanation for a
plain, specific error reason instead of a generic employee_not_found,
surfaced through the existing entry_resolution_failed error shape
Claire already knows how to read.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    for (var bi = 0; bi < beEntries.length; bi++) {
      var beEnt = beEntries[bi] || {};
      var beLookup = findEmployeeWithSuggestions(beEnt.employee || '');
      if (beLookup.matches.length > 1) {
        beErrors.push({ index: bi, employee: beEnt.employee, error: 'ambiguous_employee',
          candidates: beLookup.matches.slice(0, 5).map(function(e){ return { name: e.name, id: e.id }; }) });
        continue;
      }
      if (beLookup.matches.length === 0) {
        beErrors.push({ index: bi, employee: beEnt.employee, error: 'employee_not_found',
          suggestions: beLookup.suggestions.map(function(e){ return e.name; }) });
        continue;
      }
      var beEmp = beLookup.matches[0];
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(beEmp)) {
        beSkipped.push({ index: bi, employee: beEmp.name, date: beEnt.date || dateKey(new Date()), reason: 'salaried -- no hours tracked' });
        continue;
      }
      var beKeyId = beEmp.legacy_roster_id || beEmp.id;
      var beDate = beEnt.date || dateKey(new Date());
      var beTeam = getEmployeeTeam(beKeyId, beDate);"""

NEW = """    for (var bi = 0; bi < beEntries.length; bi++) {
      var beEnt = beEntries[bi] || {};
      // Terminated-employee date-awareness fix: resolve this entry's own
      // date BEFORE its lookup (used to be computed after) so a
      // terminated employee still resolves by name for a date before
      // she left. Each entry already carries its own date, so this is a
      // pure reordering, not new state.
      var beDate = beEnt.date || dateKey(new Date());
      var beLookup = findEmployeeWithSuggestions(beEnt.employee || '', beDate);
      if (beLookup.matches.length > 1) {
        beErrors.push({ index: bi, employee: beEnt.employee, error: 'ambiguous_employee',
          candidates: beLookup.matches.slice(0, 5).map(function(e){ return { name: e.name, id: e.id }; }) });
        continue;
      }
      if (beLookup.matches.length === 0) {
        // Terminated-employee date-awareness fix: a plain, specific
        // reason when the name belongs to someone terminated by this
        // entry's own date, instead of a generic not-found.
        var beTermExp = _claireTerminatedExplanation(beEnt.employee || '', beDate);
        if (beTermExp) {
          beErrors.push({ index: bi, employee: beEnt.employee, error: 'employee_terminated',
            message: beTermExp.name + ' was terminated on ' + _pentaFormatDateOnly(beTermExp.terminated_at) + ', so no hours can be added after that date.' });
          continue;
        }
        beErrors.push({ index: bi, employee: beEnt.employee, error: 'employee_not_found',
          suggestions: beLookup.suggestions.map(function(e){ return e.name; }) });
        continue;
      }
      var beEmp = beLookup.matches[0];
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(beEmp)) {
        beSkipped.push({ index: bi, employee: beEmp.name, date: beDate, reason: 'salaried -- no hours tracked' });
        continue;
      }
      var beKeyId = beEmp.legacy_roster_id || beEmp.id;
      var beTeam = getEmployeeTeam(beKeyId, beDate);"""

EDITS = [("batch_edit_employee_hours: date-aware lookup + terminated explanation", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
