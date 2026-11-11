#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 5 audit fix.

employee_day_off/move_employee resolved their target via
getByName()/first-match EMPLOYEE_ROSTER lookup -- NOT ambiguity-safe
(this codebase has 7+ duplicate employee-name groups, see
findEmployees' own comment). Now that _claireDispatchOrPropose resolves
the employee ambiguity-safely BEFORE the proposal exists and stores
_resolvedEmployeeId, the executor must use THAT id -- otherwise the
proposal card could name the correct "Maria Vieira" while the actual
write silently landed on a different "Maria Vieira" picked by
first-match-wins. The old lookup is kept only as a defensive fallback.

(Their underlying writes -- dailyAssignments/_pentaJobWrite-equivalent
and assignEmployee()/PentaAssignments.assign() -- are fire-and-forget
with no awaited result to verify; that's a separate, larger follow-up
noted in the ship report, out of this task's named scope of
cancel/uncancel/move/schedule_clean.)
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """  } else if (name === 'employee_day_off') {
    // Phase 6.5a: facade-first, EMPLOYEE_ROSTER fallback.
    var emp = null;
    if (window.PentaEmployees && window.PentaEmployees.getByName) emp = window.PentaEmployees.getByName(input.employee || '');
    if (!emp) emp = EMPLOYEE_ROSTER.find(function(e){ return e.name.toLowerCase() === (input.employee||'').toLowerCase(); });
    if (!emp) { _claireLastToolResult = 'Employee not found: "'+input.employee+'".'; claireReply(message || 'I couldn\\'t find that employee.'); return; }
    var dk = input.date || dateKey(new Date());"""

NEW1 = """  } else if (name === 'employee_day_off') {
    // Claire proposal-resolve-verify: prefer the id already resolved
    // (ambiguity-safe) at propose time, so this can never act on a
    // different same-named employee than the one shown on the card.
    var emp = (input._resolvedEmployeeId && window.PentaEmployees && window.PentaEmployees.getById) ? window.PentaEmployees.getById(input._resolvedEmployeeId) : null;
    if (!emp) {
      // Phase 6.5a: facade-first, EMPLOYEE_ROSTER fallback.
      if (window.PentaEmployees && window.PentaEmployees.getByName) emp = window.PentaEmployees.getByName(input.employee || '');
      if (!emp) emp = EMPLOYEE_ROSTER.find(function(e){ return e.name.toLowerCase() === (input.employee||'').toLowerCase(); });
    }
    if (!emp) { _claireLastToolResult = 'Employee not found: "'+input.employee+'".'; claireReply(message || 'I couldn\\'t find that employee.'); return; }
    var dk = input.date || _claireTodayKey();"""

OLD2 = """  } else if (name === 'move_employee') {
    // Phase 6.5a: facade-first, EMPLOYEE_ROSTER fallback.
    var emp2 = null;
    if (window.PentaEmployees && window.PentaEmployees.getByName) emp2 = window.PentaEmployees.getByName(input.employee || '');
    if (!emp2) emp2 = EMPLOYEE_ROSTER.find(function(e){ return e.name.toLowerCase() === (input.employee||'').toLowerCase(); });
    if (!emp2) { _claireLastToolResult = 'Employee not found: "'+input.employee+'".'; claireReply(message || 'I couldn\\'t find that employee.'); return; }
    var dk2 = input.date || dateKey(new Date());"""

NEW2 = """  } else if (name === 'move_employee') {
    // Claire proposal-resolve-verify: same resolved-id preference as
    // employee_day_off above.
    var emp2 = (input._resolvedEmployeeId && window.PentaEmployees && window.PentaEmployees.getById) ? window.PentaEmployees.getById(input._resolvedEmployeeId) : null;
    if (!emp2) {
      // Phase 6.5a: facade-first, EMPLOYEE_ROSTER fallback.
      if (window.PentaEmployees && window.PentaEmployees.getByName) emp2 = window.PentaEmployees.getByName(input.employee || '');
      if (!emp2) emp2 = EMPLOYEE_ROSTER.find(function(e){ return e.name.toLowerCase() === (input.employee||'').toLowerCase(); });
    }
    if (!emp2) { _claireLastToolResult = 'Employee not found: "'+input.employee+'".'; claireReply(message || 'I couldn\\'t find that employee.'); return; }
    var dk2 = input.date || _claireTodayKey();"""

EDITS = [
    ("Claire proposal-resolve-verify: employee_day_off uses resolved employee id", OLD1, NEW1),
    ("Claire proposal-resolve-verify: move_employee uses resolved employee id", OLD2, NEW2),
]

if __name__ == "__main__":
    apply_edits(EDITS)
