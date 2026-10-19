#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- Team Hours modal
(_teamHoursEligibility). Passes dateStr (already the function's own
parameter) to getUnifiedRoster, so an employee not yet terminated as
of dateStr is included and editable like anyone else. For a date
on/after her termination, getUnifiedRoster(dateStr) correctly excludes
her from `roster` entirely -- which means the pre-existing `skipped`
loop (built from the same `roster`) can never see her to report
"skipped: Terminated" either, the exact gap the spec calls out
("skipped: Terminated only for dates on/after D"). A small separate
pass over the raw facade surfaces exactly that case: someone excluded
from `roster` specifically because she's terminated as of dateStr (not
a day-off/unassigned case), looked up against the team she was
actually on the day before she left (her defaultTeam is cleared at
termination, so it can't be read off her current row any more).

isActive()/termData (getRosterTermData/roster_term_data) is confirmed
dead code elsewhere in this file (nothing ever writes to that
localStorage key) -- already always true, so it was never actually
gating anything. Left in place: not the source of this bug, and
removing dead code is out of scope here.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function _teamHoursEligibility(team, dateStr) {
  var termData = getRosterTermData();
  var isActive = function(e) { return (termData[e.id]?.status || 'active') !== 'terminated'; };
  var roster = getUnifiedRoster();
  // Defensive second guard (matches getTeamEmployees' own pattern) --
  // getEmployeeTeam already can't return a real team for an Admin/
  // Office employee (verified: no defaultTeam, and both
  // _setEmployeeDefaultTeam and quickAssign refuse to ever set one),
  // so this can't change observable behavior today. It's here so this
  // modal can never silently include an Admin/Office employee (salaried
  // or not) even if that guard chain ever changes.
  var included = roster.filter(function(e) { return getEmployeeTeam(e.id, dateStr) === team && isActive(e) && e.work_type !== 'admin'; });
  var includedIds = {};
  included.forEach(function(e) { includedIds[e.id] = true; });
  var skipped = [];
  roster.filter(function(e) { return e.defaultTeam === team; }).forEach(function(e) {
    if (includedIds[e.id]) return;
    if (!isActive(e)) { skipped.push({ emp: e, reason: 'Terminated' }); return; }
    var off = getEmployeeDayOffInfo(e.id, dateStr);
    if (off) {
      skipped.push({ emp: e, reason: (off.status_type && DAY_OFF_CATEGORY_LABELS[off.status_type]) || 'Day Off' });
    }
  });
  return { included: included, skipped: skipped };
}"""

NEW = """function _teamHoursEligibility(team, dateStr) {
  var termData = getRosterTermData();
  var isActive = function(e) { return (termData[e.id]?.status || 'active') !== 'terminated'; };
  // Terminated-employee date-awareness fix: dateStr is this function's
  // own parameter -- an employee not yet terminated as of dateStr
  // belongs in this modal at all, exactly like any other employee.
  var roster = getUnifiedRoster(dateStr);
  // Defensive second guard (matches getTeamEmployees' own pattern) --
  // getEmployeeTeam already can't return a real team for an Admin/
  // Office employee (verified: no defaultTeam, and both
  // _setEmployeeDefaultTeam and quickAssign refuse to ever set one),
  // so this can't change observable behavior today. It's here so this
  // modal can never silently include an Admin/Office employee (salaried
  // or not) even if that guard chain ever changes.
  var included = roster.filter(function(e) { return getEmployeeTeam(e.id, dateStr) === team && isActive(e) && e.work_type !== 'admin'; });
  var includedIds = {};
  included.forEach(function(e) { includedIds[e.id] = true; });
  var skipped = [];
  roster.filter(function(e) { return e.defaultTeam === team; }).forEach(function(e) {
    if (includedIds[e.id]) return;
    if (!isActive(e)) { skipped.push({ emp: e, reason: 'Terminated' }); return; }
    var off = getEmployeeDayOffInfo(e.id, dateStr);
    if (off) {
      skipped.push({ emp: e, reason: (off.status_type && DAY_OFF_CATEGORY_LABELS[off.status_type]) || 'Day Off' });
    }
  });
  // Terminated-employee date-awareness fix: an employee excluded from
  // `roster` above specifically because she's terminated as of dateStr
  // (not a day-off/unassigned case) still needs to show up as
  // "skipped: Terminated" per spec, not just silently vanish. `roster`
  // (dated) can never contain her for this branch by construction, so
  // this reads the raw facade directly and checks the exact same
  // isTerminatedAsOf-style comparison. Her defaultTeam is already
  // cleared at termination, so "was she on THIS team" is resolved via
  // getEmployeeTeam for the day before her termination (her actual last
  // working day under the documented D-exclusive rule), not her
  // current row.
  var facadeAll = (window.PentaEmployees && window.PentaEmployees.listSync) ? window.PentaEmployees.listSync() : [];
  facadeAll.forEach(function(fe) {
    var rosterId = fe.legacy_roster_id || fe.id;
    if (includedIds[rosterId] || includedIds[fe.id]) return;
    if (fe.status !== 'terminated' || !fe.terminated_at || dateStr < fe.terminated_at) return;
    var lastDay = new Date(fe.terminated_at + 'T00:00:00');
    lastDay.setDate(lastDay.getDate() - 1);
    var lastTeam = getEmployeeTeam(rosterId, dateKey(lastDay));
    if (lastTeam !== team) return;
    skipped.push({ emp: { id: rosterId, uuid: fe.id, name: fe.name, role: [] }, reason: 'Terminated' });
  });
  return { included: included, skipped: skipped };
}"""

EDITS = [("_teamHoursEligibility: date-aware roster + terminated-as-of-dateStr surfacing", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
