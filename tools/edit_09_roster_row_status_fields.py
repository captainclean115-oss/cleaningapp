#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- add status/terminated_at
to getUnifiedRoster's own pushed row shape (same passthrough pattern as
the existing work_type/pay_type fields). Purely additive: no existing
consumer reads these two fields today (they didn't exist on this row
shape before), so nothing can regress from them being added. Needed by
Claire's new "she was terminated on X" explanation helper, which must
tell a real termination date apart from a genuinely-unknown name
without re-deriving isTerminatedAsOf's own comparison a third time.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "getUnifiedRoster: pass through status/terminated_at on each row",
        """          pay_type: fe.pay_type || null
        });""",
        """          pay_type: fe.pay_type || null,
          // Terminated-employee date-awareness fix -- same passthrough
          // pattern as work_type/pay_type just above. Lets a consumer
          // that already has a roster row (e.g. Claire's name
          // resolution) tell a real termination date apart from a
          // genuinely-unknown name without a second facade read.
          status: fe.status || 'active',
          terminated_at: fe.terminated_at || null
        });""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
