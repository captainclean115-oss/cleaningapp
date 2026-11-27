#!/usr/bin/env python3
"""manage-permissions-button-fix -- PART 4. THE exact bug Tom hit:
openManagerPermissionsModal awaited _pentaFetchUserRoleRow with no
timeout, and its own onclick call site never caught a rejection either
-- a stalled network call (or anything else throwing) left the button
tap doing literally nothing, with zero visible feedback. Confirmed
reproducible in a sandbox with no real credentials: feeding it a
Supabase call that never resolves leaves the promise hanging forever,
no alert, nothing appended to the DOM.

Fix: the real logic moves into _openManagerPermissionsModalInner;
openManagerPermissionsModal becomes a thin wrapper that always catches
any throw/rejection and shows a visible alert -- never a silent no-op
again, matching the same discipline the login-hang-fix task already
applied to the sign-in button. The one await inside that touches the
network also races against the same 18s timeout.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_DECL = "async function openManagerPermissionsModal(emp) {"
NEW_DECL = "async function _openManagerPermissionsModalInner(emp) {"

OLD_FETCH = """  var existing = await _pentaFetchUserRoleRow(emp);
  if (!existing || existing.role !== 'manager') {
    alert('Grant manager access first, then set permissions.');
    return;
  }"""
NEW_FETCH = """  var existing = (typeof _pentaWithTimeout === 'function')
    ? await _pentaWithTimeout(_pentaFetchUserRoleRow(emp), 18000)
    : await _pentaFetchUserRoleRow(emp);
  if (!existing || existing.role !== 'manager') {
    alert('Grant manager access first, then set permissions.');
    return;
  }"""

OLD_END_ANCHOR = """    } catch (e) {
      msgEl.textContent = 'Save failed: ' + (e.message || e);
      msgEl.style.color = 'var(--red)';
      btn.disabled = false;
    }
  });
}"""
NEW_END_ANCHOR = """    } catch (e) {
      msgEl.textContent = 'Save failed: ' + (e.message || e);
      msgEl.style.color = 'var(--red)';
      btn.disabled = false;
    }
  });
}

// manage-permissions-button-fix: the real public entry point. Always
// catches -- a timeout, a thrown error, anything -- so tapping "Manage
// permissions" can never again do nothing with no visible sign of why.
async function openManagerPermissionsModal(emp) {
  try {
    await _openManagerPermissionsModalInner(emp);
  } catch (e) {
    var msg = (e && e.message === 'penta-login-timeout')
      ? "Couldn't open permissions: taking too long to respond. Tap Manage permissions to try again."
      : "Couldn't open permissions: " + (e && e.message || 'unknown error') + '. Tap Manage permissions to try again.';
    console.error('[openManagerPermissionsModal]', e);
    alert(msg);
  }
}"""

EDITS = [
    ("manage-permissions-button-fix: rename the real implementation", OLD_DECL, NEW_DECL),
    ("manage-permissions-button-fix: add a timeout to the role-row fetch", OLD_FETCH, NEW_FETCH),
    ("manage-permissions-button-fix: add the always-catches public wrapper", OLD_END_ANCHOR, NEW_END_ANCHOR),
]

if __name__ == "__main__":
    apply_edits(EDITS)
