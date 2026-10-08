#!/usr/bin/env python3
"""Edit 3/N -- salaried Admin/Office feature.

saveStaffEmployee: read the Pay Type control, set emp.pay_type, and --
critically -- add it to the SAME hand-built dual-write patch that has
already dropped a field from this exact path before (work_type itself,
position, is_team_leader/is_driver). Reusing the existing employees.
pay_type column -- no schema change.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "saveStaffEmployee: compute newPayType alongside newWorkType",
        """  const newWorkType = ((document.getElementById('staff-work-type')||{}).value === 'admin') ? 'admin' : 'field';
  const oldWorkType = (idx >= 0 && list[idx] && list[idx].work_type === 'admin') ? 'admin' : 'field';
  const isWorkTypeSwitch = idx >= 0 && newWorkType !== oldWorkType;""",
        """  const newWorkType = ((document.getElementById('staff-work-type')||{}).value === 'admin') ? 'admin' : 'field';
  const oldWorkType = (idx >= 0 && list[idx] && list[idx].work_type === 'admin') ? 'admin' : 'field';
  const isWorkTypeSwitch = idx >= 0 && newWorkType !== oldWorkType;

  // Salaried Admin/Office (follow-up to migration 113). Reuses the
  // existing employees.pay_type column (employee_pay_type enum:
  // 'hourly' | 'salary' -- confirmed live via information_schema, not
  // guessed). No confirm dialog for this one on its own -- only the
  // Work Type switch above has manager-visible consequences (team/
  // assignment changes); Pay Type alone just changes how this
  // employee's hours/pay are tracked going forward.
  const newPayType = ((document.getElementById('staff-pay-type')||{}).value === 'salary') ? 'salary' : 'hourly';""",
    ),
    (
        "saveStaffEmployee: carry pay_type onto the emp object",
        "    work_type: newWorkType,\n    // v9.5: portal permission role.",
        "    work_type: newWorkType,\n    pay_type: newPayType,\n    // v9.5: portal permission role.",
    ),
    (
        "saveStaffEmployee: carry pay_type onto the real dual-write patch (the gap that's bitten this app before)",
        """        // Admin/Office designation (migration 113). This hand-built
        // patch is a SEPARATE mapping from _toRow's -- the exact gap
        // that already dropped `position` (v9.5.1) and is_team_leader/
        // is_driver (v10.5.40) from this same dual-write once each.
        // work_type must land here too (team_id/team_text already do,
        // just above), or the Work Type dropdown silently fails to
        // persist from this modal specifically, same bug, 6th time.
        if (emp.work_type !== undefined) patch.work_type = emp.work_type === 'admin' ? 'admin' : 'field';""",
        """        // Admin/Office designation (migration 113). This hand-built
        // patch is a SEPARATE mapping from _toRow's -- the exact gap
        // that already dropped `position` (v9.5.1) and is_team_leader/
        // is_driver (v10.5.40) from this same dual-write once each.
        // work_type must land here too (team_id/team_text already do,
        // just above), or the Work Type dropdown silently fails to
        // persist from this modal specifically, same bug, 6th time.
        if (emp.work_type !== undefined) patch.work_type = emp.work_type === 'admin' ? 'admin' : 'field';
        // Salaried Admin/Office follow-up -- same gap, same fix, for
        // the Pay Type dropdown's pay_type column.
        if (emp.pay_type !== undefined) patch.pay_type = emp.pay_type === 'salary' ? 'salary' : 'hourly';""",
    ),
]

apply_edits(EDITS)
