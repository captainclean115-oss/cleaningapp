#!/usr/bin/env python3
"""Salary amount/period follow-up -- the actual write.

Deliberately its OWN Supabase call, separate from the big hand-built
`patch` a few lines above (name/phone/work_type/pay_type/etc). Reason:
that big patch update is relied on for EVERY Staff save, salaried or
not -- if salary_amount/salary_period were added to it directly and the
migration 114 columns didn't exist yet, PostgREST would reject the
WHOLE update (not just the two new fields), silently breaking every
other field (phone, address, work_type...) for any employee who happens
to be marked Salaried. Isolating it here means a missing-column failure
can only ever affect the salary write itself -- everything else about
the save still succeeds -- and failure is never silent: a visible alert
names exactly what didn't save and why.

Only fires when Pay Type = Salaried AND the amount/period pair actually
changed from what's on file (skips a no-op write + a spurious audit row
on every unrelated re-save). Writes an audit_log row via the existing
_auditSupplement helper (source='staff_salary_edit') carrying old/new
values -- _auditSupplement itself already resolves "who made the
change" from the logged-in user.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "define _staffSaveSalaryFields helper before saveStaffEmployee",
        """  reader.readAsDataURL(file);
}
async function saveStaffEmployee() {""",
        """  reader.readAsDataURL(file);
}

// Salary amount/period (migration 114 follow-up) -- isolated write, see
// module comment above this edit for why it's kept separate from the
// main Staff dual-write patch. supaRowId is the real employees.id uuid
// (same one the main patch update just targeted). oldAmount/oldPeriod
// are what was on file BEFORE this save (read from the pre-update
// in-memory row); newAmount/newPeriod are the validated values from
// saveStaffEmployee's own validation step. No-ops (and writes nothing,
// logs nothing) when nothing actually changed.
async function _staffSaveSalaryFields(supaRowId, employeeName, oldAmount, oldPeriod, newAmount, newPeriod) {
  try {
    var oldAmt = (oldAmount != null) ? oldAmount : null;
    var oldPer = (oldPeriod != null) ? oldPeriod : null;
    if (newAmount === oldAmt && newPeriod === oldPer) return;
    if (!window.PentaEmployees || typeof window.PentaEmployees.update !== 'function') {
      throw new Error('PentaEmployees.update unavailable');
    }
    await window.PentaEmployees.update(supaRowId, { salary_amount: newAmount, salary_period: newPeriod });
    try {
      if (typeof _auditSupplement === 'function') {
        await _auditSupplement('updated', 'employee', supaRowId, {
          source: 'staff_salary_edit',
          old_salary_amount: oldAmt, new_salary_amount: newAmount,
          old_salary_period: oldPer, new_salary_period: newPeriod
        });
      }
    } catch (auditErr) { console.warn('[staff salary] audit supplement failed (non-fatal)', auditErr); }
  } catch (salErr) {
    console.error('[staff salary] salary_amount/salary_period save failed', salErr);
    alert('Everything else for ' + employeeName + ' was saved, but the Salary amount/period could not be saved.\\n\\n' + (salErr && salErr.message ? salErr.message : String(salErr)) + '\\n\\nIf this is a brand-new field, the database migration may not be applied yet -- ask your developer.');
  }
}

async function saveStaffEmployee() {""",
    ),
    (
        "saveStaffEmployee: call the isolated salary write after the main dual-write succeeds",
        """        if (isWorkTypeSwitch) {
          try { await switchEmployeeWorkType(supaRow.id, newWorkType); }
          catch (wtErr) { console.error('[saveStaffEmployee] switchEmployeeWorkType side effects failed (work_type itself was already saved)', wtErr); }
        }
      } else {
        console.log('[Sprint 4.1] No Supabase row for', rosterId, '— backfill will handle it');
      }
    }
  } catch (e) {
    console.error('[Sprint 4.1] Staff edit dual-write failed:', e);
  }""",
        """        if (isWorkTypeSwitch) {
          try { await switchEmployeeWorkType(supaRow.id, newWorkType); }
          catch (wtErr) { console.error('[saveStaffEmployee] switchEmployeeWorkType side effects failed (work_type itself was already saved)', wtErr); }
        }
        // Salary amount/period (migration 114 follow-up) -- isolated
        // write, see _staffSaveSalaryFields for why. newPayType !==
        // 'salary' means these columns are never touched at all, so a
        // previously-saved amount/period is left exactly as it was.
        if (newPayType === 'salary') {
          await _staffSaveSalaryFields(supaRow.id, name, supaRow.salary_amount, supaRow.salary_period, salaryAmount, salaryPeriod);
        }
      } else {
        console.log('[Sprint 4.1] No Supabase row for', rosterId, '— backfill will handle it');
      }
    }
  } catch (e) {
    console.error('[Sprint 4.1] Staff edit dual-write failed:', e);
  }""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
