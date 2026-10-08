#!/usr/bin/env python3
"""Edit 7/N -- salaried Admin/Office feature.

Hard-block the single-employee edit-hours sheet for a salaried admin
employee -- defense in depth. The normal UI path can no longer even
reach this (the Live Hours Admin/Office group's salaried row has no
day cells / onclick at all after edit 5), but Claire or a future code
path could still call showEmpDayDetail/saveEmpDayHours directly, and
the spec is explicit: "never a silent return." Both functions resolve
the real employee via getUnifiedRoster() (synchronous read of the
already-hydrated facade cache -- same convention every other call site
in this file uses) and alert with a clear message instead of silently
doing nothing.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "showEmpDayDetail: hard-block opening the edit sheet for a salaried admin employee",
        """function showEmpDayDetail(empId, empName, team, dateMs) {
  localStorage.removeItem('_empLunchStop');
  var date = new Date(dateMs);""",
        """function showEmpDayDetail(empId, empName, team, dateMs) {
  // Salaried Admin/Office (follow-up to migration 113): no hours entry
  // anywhere, ever -- the normal Live Hours UI can no longer even
  // reach this function for a salaried admin (no day cells, no
  // onclick), but refuse explicitly rather than silently opening a
  // sheet that would let someone save hours for them anyway.
  try {
    var _sedEmp = getUnifiedRoster().find(function(e) { return e.id === empId; });
    if (_sedEmp && typeof isSalariedAdmin === 'function' && isSalariedAdmin(_sedEmp)) {
      alert(_sedEmp.name + ' is salaried -- there are no hours to enter.');
      return;
    }
  } catch (e) { console.warn('[showEmpDayDetail] salaried-admin check failed (non-fatal, continuing to open)', e); }
  localStorage.removeItem('_empLunchStop');
  var date = new Date(dateMs);""",
    ),
    (
        "saveEmpDayHours: hard-block the actual write for a salaried admin employee",
        """async function saveEmpDayHours(empId, empName, dk) {
  // v11.0.30 -- this had NO error handling at all, and re-rendered via a""",
        """async function saveEmpDayHours(empId, empName, dk) {
  // Salaried Admin/Office (follow-up to migration 113): hard-block the
  // actual write too, not just the UI entry point above -- defense in
  // depth, since this is reachable by id/name/date alone from
  // anywhere, not only from showEmpDayDetail's own Save button.
  try {
    var _sehEmp = getUnifiedRoster().find(function(e) { return e.id === empId; });
    if (_sehEmp && typeof isSalariedAdmin === 'function' && isSalariedAdmin(_sehEmp)) {
      alert(_sehEmp.name + ' is salaried, so there are no hours to save. Nothing was changed.');
      return;
    }
  } catch (e) { console.warn('[saveEmpDayHours] salaried-admin check failed (non-fatal, continuing to save)', e); }
  // v11.0.30 -- this had NO error handling at all, and re-rendered via a""",
    ),
]

apply_edits(EDITS)
