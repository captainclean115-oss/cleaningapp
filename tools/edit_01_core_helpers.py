#!/usr/bin/env python3
"""Edit 1/N -- salaried Admin/Office feature.

- Carry pay_type through getUnifiedRoster()'s facade row (it already
  carries work_type the same way, added for migration 113).
- Carry pay_type through _bootResolveEmployeeFromAuth's fast portal-
  login path (same reasoning as work_type there).
- Add the ONE shared isSalariedAdmin(emp) helper, placed right next to
  _adminEmpDayOff -- every other site in this feature calls this
  instead of re-checking work_type/pay_type inline, per explicit
  instruction not to duplicate the logic.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "getUnifiedRoster: carry pay_type through the facade row",
        """          // Admin/Office designation (migration 113). Every roster-
          // scoped consumer (Team Manager, Live/Export Hours, Claire,
          // the portal) reads this straight off getUnifiedRoster()'s
          // own rows rather than re-querying the facade itself.
          work_type: fe.work_type === 'admin' ? 'admin' : 'field'
        });""",
        """          // Admin/Office designation (migration 113). Every roster-
          // scoped consumer (Team Manager, Live/Export Hours, Claire,
          // the portal) reads this straight off getUnifiedRoster()'s
          // own rows rather than re-querying the facade itself.
          work_type: fe.work_type === 'admin' ? 'admin' : 'field',
          // Salaried Admin/Office follow-up: pay_type (existing column,
          // employee_pay_type enum -- 'hourly' | 'salary') carried
          // through the same way, so isSalariedAdmin() below can read
          // it straight off this roster row without a second facade
          // lookup.
          pay_type: fe.pay_type || null
        });""",
    ),
    (
        "_bootResolveEmployeeFromAuth: select pay_type too",
        ".select('id, legacy_roster_id, first_name, last_name, team_text, team_id, culture_tag, position, photo_url, status, auth_user_id, work_type')",
        ".select('id, legacy_roster_id, first_name, last_name, team_text, team_id, culture_tag, position, photo_url, status, auth_user_id, work_type, pay_type')",
    ),
    (
        "_bootResolveEmployeeFromAuth: return pay_type on the resolved employee object",
        "          work_type: (m.work_type === 'admin') ? 'admin' : 'field',",
        "          work_type: (m.work_type === 'admin') ? 'admin' : 'field',\n          pay_type: m.pay_type || null,",
    ),
    (
        "Add the shared isSalariedAdmin(emp) helper next to _adminEmpDayOff",
        """function _adminEmpDayOff(employeeId, dateStr) {
  if (dailyAssignments[dateStr + '_' + employeeId] !== 'OFF') return null;
  var info = dailyAssignmentDetails[dateStr + '_' + employeeId] || null;
  var statusType = info && info.status_type;
  return { status_type: statusType || null, label: (statusType && DAY_OFF_CATEGORY_LABELS[statusType]) || 'Off' };
}""",
        """function _adminEmpDayOff(employeeId, dateStr) {
  if (dailyAssignments[dateStr + '_' + employeeId] !== 'OFF') return null;
  var info = dailyAssignmentDetails[dateStr + '_' + employeeId] || null;
  var statusType = info && info.status_type;
  return { status_type: statusType || null, label: (statusType && DAY_OFF_CATEGORY_LABELS[statusType]) || 'Off' };
}

// Salaried Admin/Office (follow-up to migration 113). THE single check
// every hours surface in this file uses to decide "does this employee
// get hours tracked at all" -- duplicated copies of this exact check
// are what has diverged on us before (work_type's own "no team = OFF"
// bug existed in 3 separate places until it was fixed once each).
// `pay_type` is the existing employees.pay_type column -- a Postgres
// enum (employee_pay_type: 'hourly' | 'salary', confirmed live via
// information_schema; NOT the string "salaried"). Field employees with
// pay_type='salary' are deliberately NOT matched here -- commissions/
// salaried-field behavior is out of scope, and the spec is explicit
// that only the admin+salary combination changes anything.
function isSalariedAdmin(emp) {
  if (!emp) return false;
  return emp.work_type === 'admin' && emp.pay_type === 'salary';
}""",
    ),
]

apply_edits(EDITS)
