#!/usr/bin/env python3
"""Edit 10/N -- salaried Admin/Office feature.

Claire's three hours tools, reusing the ONE isSalariedAdmin(emp) helper
everywhere rather than re-deriving the check:
  - get_employee_hours: reports "salaried, no hours tracked" per date,
    checked BEFORE the existing Admin/Office (hourly) branch.
  - edit_employee_hours: hard refusal with a plain message, before any
    read/write happens.
  - batch_edit_employee_hours: salaried entries are SKIPPED (not an
    error that aborts the whole batch) and listed as skipped in the
    preview; the confirmed-write loop only ever iterates beResolved,
    which never contains them, so there's no separate write-path guard
    needed there.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "get_employee_hours: salaried branch before the existing Admin/Office (hourly) branch",
        """      var ghDayLabel = new Date(ghDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

      // Admin/Office designation (migration 113). getEmployeeTeam""",
        """      var ghDayLabel = new Date(ghDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

      // Salaried Admin/Office (follow-up to migration 113). Checked
      // BEFORE the plain (hourly) Admin/Office branch right below --
      // no hours are ever tracked for a salaried employee, so there's
      // no override/GPS distinction to make at all.
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(ghEmp)) {
        ghResults.push({ date: ghDate, day_of_week: ghDayLabel, status: 'salaried', reason: ghEmp.name + ' is salaried, no hours tracked.' });
        continue;
      }

      // Admin/Office designation (migration 113). getEmployeeTeam""",
    ),
    (
        "edit_employee_hours: hard refusal for a salaried admin employee",
        """    var ehEmp = ehLookup.matches[0];
    // PR #134 -- every empHrs_* reader/writer (renderHoursTable,""",
        """    var ehEmp = ehLookup.matches[0];
    // Salaried Admin/Office (follow-up to migration 113): hard refusal
    // before any read/write -- there is nothing to edit.
    if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(ehEmp)) {
      var ehSalMsg = ehEmp.name + ' is salaried, so there are no hours to edit.';
      _claireLastToolResult = ehSalMsg;
      claireReply(message || ehSalMsg);
      return;
    }
    // PR #134 -- every empHrs_* reader/writer (renderHoursTable,""",
    ),
    (
        "batch_edit_employee_hours: declare beSkipped alongside beErrors",
        """    var beResolved = [];
    var beErrors = [];
    for (var bi = 0; bi < beEntries.length; bi++) {""",
        """    var beResolved = [];
    var beErrors = [];
    // Salaried Admin/Office entries are SKIPPED, not an error -- they
    // don't abort the whole batch (beErrors does), they just never
    // make it into beResolved, so the confirmed-write loop below
    // (which only iterates beResolved) can never write hours for them.
    var beSkipped = [];
    for (var bi = 0; bi < beEntries.length; bi++) {""",
    ),
    (
        "batch_edit_employee_hours: skip (don't resolve) a salaried admin entry",
        """      var beEmp = beLookup.matches[0];
      var beKeyId = beEmp.legacy_roster_id || beEmp.id;
      var beDate = beEnt.date || dateKey(new Date());
      var beTeam = getEmployeeTeam(beKeyId, beDate);""",
        """      var beEmp = beLookup.matches[0];
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(beEmp)) {
        beSkipped.push({ index: bi, employee: beEmp.name, date: beEnt.date || dateKey(new Date()), reason: 'salaried -- no hours tracked' });
        continue;
      }
      var beKeyId = beEmp.legacy_roster_id || beEmp.id;
      var beDate = beEnt.date || dateKey(new Date());
      var beTeam = getEmployeeTeam(beKeyId, beDate);""",
    ),
    (
        "batch_edit_employee_hours: surface skipped entries in the preview",
        """      _claireLastToolResult = JSON.stringify({
        preview: true,
        changes: beResolved.map(function(r) {
          var pStart = r.proposed.start || (r.currentOverride && r.currentOverride.start);
          var pEnd = r.proposed.end || (r.currentOverride && r.currentOverride.end);
          var proposedLabel = (r.proposed.start || r.proposed.end) ? (_hrsFmt12(pStart) + ' - ' + _hrsFmt12(pEnd))
            : (r.proposed.lunch ? 'lunch: ' + r.proposed.lunch + 'min' : '(no change specified)');
          return { employee: r.employee.name, date: r.date, current: r.currentLabel, proposed: proposedLabel };
        })
      });
      return;
    }""",
        """      _claireLastToolResult = JSON.stringify({
        preview: true,
        changes: beResolved.map(function(r) {
          var pStart = r.proposed.start || (r.currentOverride && r.currentOverride.start);
          var pEnd = r.proposed.end || (r.currentOverride && r.currentOverride.end);
          var proposedLabel = (r.proposed.start || r.proposed.end) ? (_hrsFmt12(pStart) + ' - ' + _hrsFmt12(pEnd))
            : (r.proposed.lunch ? 'lunch: ' + r.proposed.lunch + 'min' : '(no change specified)');
          return { employee: r.employee.name, date: r.date, current: r.currentLabel, proposed: proposedLabel };
        }),
        skipped: beSkipped
      });
      return;
    }""",
    ),
]

apply_edits(EDITS)
