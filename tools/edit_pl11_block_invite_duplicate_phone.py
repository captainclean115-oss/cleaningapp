#!/usr/bin/env python3
"""Phone + password login feature. Blocks sending an invite when the
employee's phone number is shared with another ACTIVE employee --
confirmed live this is a real, current case (Blanca Payan / Viviana).
Checked against the already-hydrated PentaEmployees facade (no extra
network round trip), same normalization rule used everywhere else in
this feature.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    var emp = resolved.employee;
    if (!emp.phone) {
      alert('No phone number on file for ' + (emp.first_name || 'this employee') + '. Add a phone in the Staff edit form first.');
      return;
    }

    // Generate token + expiry"""

NEW = """    var emp = resolved.employee;
    if (!emp.phone) {
      alert('No phone number on file for ' + (emp.first_name || 'this employee') + '. Add a phone in the Staff edit form first.');
      return;
    }
    // Phone + password login feature: block the invite if this phone is
    // shared with another ACTIVE employee -- phone login/reset need it
    // to uniquely resolve an account for invites going forward.
    try {
      var _normInv = String(emp.phone || '').replace(/\\D/g, '');
      if (_normInv.length === 11 && _normInv[0] === '1') _normInv = _normInv.slice(1);
      if (_normInv.length === 10 && window.PentaEmployees && window.PentaEmployees.listSync) {
        var _dupOwner = window.PentaEmployees.listSync().find(function (e) {
          if (!e || e.id === emp.id || e.status !== 'active') return false;
          var n2 = String(e.phone || '').replace(/\\D/g, '');
          if (n2.length === 11 && n2[0] === '1') n2 = n2.slice(1);
          return n2.length === 10 && n2 === _normInv;
        });
        if (_dupOwner) {
          alert((emp.first_name || 'This employee') + '\\'s phone number is shared with ' + (_dupOwner.first_name || 'another active employee') + '. Fix one of their phone numbers in the Staff edit form before inviting -- phone sign-in needs each active employee to have her own number.');
          return;
        }
      }
    } catch (e) { console.warn('[pentaSendInvite] duplicate-phone check failed (non-fatal, proceeding)', e); }

    // Generate token + expiry"""

EDITS = [("pentaSendInvite: block invite when phone is shared with another active employee", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
