#!/usr/bin/env python3
"""Payroll cost tally feature. getUnifiedRoster()'s constructed roster
row selectively copies fields consumers need (work_type, pay_type,
status, terminated_at, ...) from the facade row -- pay_rate was never
one of them, so publishWeekHours() (which iterates this roster) has no
way to read an employee's hourly rate. One-line addition, same pattern
as the existing fields.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """          pay_type: fe.pay_type || null,
          // Terminated-employee date-awareness fix -- same passthrough
          // pattern as work_type/pay_type just above. Lets a consumer
          // that already has a roster row (e.g. Claire's name
          // resolution) tell a real termination date apart from a
          // genuinely-unknown name without a second facade read.
          status: fe.status || 'active',
          terminated_at: fe.terminated_at || null
        });"""

NEW = """          pay_type: fe.pay_type || null,
          // Payroll cost tally feature: same passthrough pattern as
          // work_type/pay_type above. publishWeekHours() and the
          // payroll cost card both need an hourly rate per roster row
          // without a second facade lookup. null (not 0) when unset or
          // non-positive -- a $0/hr rate is never treated as real.
          pay_rate: (fe.pay_rate != null && fe.pay_rate > 0) ? fe.pay_rate : null,
          // Terminated-employee date-awareness fix -- same passthrough
          // pattern as work_type/pay_type just above. Lets a consumer
          // that already has a roster row (e.g. Claire's name
          // resolution) tell a real termination date apart from a
          // genuinely-unknown name without a second facade read.
          status: fe.status || 'active',
          terminated_at: fe.terminated_at || null
        });"""

EDITS = [("getUnifiedRoster: pass through pay_rate", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
