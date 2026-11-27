#!/usr/bin/env python3
"""manage-permissions-button-fix -- PART 2. THE actual access-control
bug: _pentaSetManagerAccess's "existing users row" branch only ever
updated role, never manager_permissions -- so a genuinely NEW
promotion (an employee who already had a `users` row with no saved
permissions, e.g. role='employee') never got the Limited manager
preset, even though the brand-new-row INSERT branch right below it
did. Confirmed live: Nadia's row is role='manager',
manager_permissions={} -- full, unrestricted access, not Limited.

Fix: only skip applying the preset when she was ALREADY a manager
before (a demote-then-re-promote cycle, which correctly restores her
prior custom permissions instead of resetting them -- unchanged
behavior, already tested in Stage 1). Every other case -- including
Nadia's -- now gets the Limited preset here too, not just on brand-new
rows.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    // Turning ON.
    if (existing) {
      if (existing.role === 'owner' || existing.role === 'admin') {
        alert('This person already has owner/admin access.');
        return true;
      }
      var on = await sb.from('users').update({ role: 'manager' }).eq('id', existing.id);
      if (on.error) { alert('Could not grant manager access: ' + on.error.message); return false; }
      return true;
    }"""

NEW = """    // Turning ON.
    if (existing) {
      if (existing.role === 'owner' || existing.role === 'admin') {
        alert('This person already has owner/admin access.');
        return true;
      }
      var updatePatch = { role: 'manager' };
      // Bug fix: a genuinely NEW promotion must start from Limited
      // manager even when a users row already existed (e.g. role was
      // 'employee') -- only the brand-new-row insert path below was
      // applying this preset. Skip it ONLY when she was already a
      // manager before (demote-then-re-promote), which should restore
      // her prior custom permissions instead of resetting them.
      var wasAlreadyManagerBefore = existing.role === 'manager';
      var hasNoSavedPermsYet = !existing.manager_permissions || Object.keys(existing.manager_permissions).length === 0;
      if (!wasAlreadyManagerBefore && hasNoSavedPermsYet && typeof PRESET_PERMISSIONS !== 'undefined' && PRESET_PERMISSIONS.limited_manager) {
        updatePatch.manager_permissions = Object.assign({}, PRESET_PERMISSIONS.limited_manager);
      }
      var on = await sb.from('users').update(updatePatch).eq('id', existing.id);
      if (on.error) { alert('Could not grant manager access: ' + on.error.message); return false; }
      return true;
    }"""

EDITS = [
    ("manage-permissions-button-fix: apply the Limited preset on the existing-row promotion branch too", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
