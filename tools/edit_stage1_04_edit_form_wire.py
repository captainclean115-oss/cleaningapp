#!/usr/bin/env python3
"""Stage 1 -- PART 4. Wire the Edit tab's Manager Access section inside
openEditStaff, same pattern as every other field it hydrates -- runs
once per profile open, regardless of which tab is shown first.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  document.getElementById('staff-delete-btn').style.display = 'block';
  document.getElementById('staff-hard-delete-btn').style.display = 'block';
  document.getElementById('staff-save-msg').textContent = '';
  document.getElementById('staff-modal').style.display = 'block';
  showStaffTab('view');
}"""

NEW = """  document.getElementById('staff-delete-btn').style.display = 'block';
  document.getElementById('staff-hard-delete-btn').style.display = 'block';
  document.getElementById('staff-save-msg').textContent = '';
  document.getElementById('staff-modal').style.display = 'block';
  // Stage 1: Manager Access section on the Edit tab -- fixed ids, one
  // instance reused per employee open (unlike the View tab's
  // per-roster-id data attributes).
  try {
    _renderManagerAccessSection(emp, {
      wrapEl: document.getElementById('staff-edit-mgr-access-wrap'),
      statusEl: document.getElementById('staff-edit-mgr-access-status'),
      toggleWrap: document.getElementById('staff-edit-mgr-access-toggle-wrap'),
      toggleEl: document.getElementById('staff-edit-mgr-access-toggle'),
      permLinkEl: document.getElementById('staff-edit-mgr-access-permlink')
    });
  } catch (e) { console.warn('[Manager Access section] edit-tab wiring failed', e); }
  showStaffTab('view');
}"""

EDITS = [
    ("Stage 1: wire Manager Access section inside openEditStaff", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
