#!/usr/bin/env python3
"""Stage 1 (manager promotion from the employee profile) -- PART 1.

Shared helpers for the new "Manager access" section on both the Staff
View and Edit tabs. Role lives entirely in the SEPARATE `users` table
(not `employees`) -- confirmed in Stage 0 research. These functions are
the single place that reads/writes that role for this feature, reused
by both tabs rather than duplicated.

Grant/revoke rules enforced here (client-side for now -- Stage 2 adds
the matching server-side lock-down on who may write `users` at all):
  - Owner/admin only may call _pentaSetManagerAccess.
  - Nobody can change their own access.
  - This control never touches an owner's or admin's role -- it only
    ever moves someone between 'employee' and 'manager'. That also
    means the "last owner" and "promote to owner" guards the task asks
    for are satisfied by construction: there is no code path here that
    can ever set or remove 'owner'.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = "function renderStaffView() {"

NEW = """// Stage 1 (manager promotion from the employee profile): shared
// helpers for the "Manager access" section on both the Staff View and
// Edit tabs. Role lives in the SEPARATE `users` table, not `employees`.

function _pentaIsOwnerOrAdmin() {
  var r = (typeof getCurrentAppRole === 'function') ? getCurrentAppRole() : null;
  return r === 'owner' || r === 'admin';
}

// Resolves the users row (if any) for this employee: by auth_user_id
// when she already has a login, else by business_id+email -- the same
// keying saveStaffEmployee's own pre-insert-then-reconcile pattern uses
// for a brand-new manager who hasn't accepted an invite yet.
async function _pentaFetchUserRoleRow(emp) {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) return null;
  try {
    if (emp.auth_user_id) {
      var r1 = await sb.from('users').select('id, role, manager_permissions').eq('auth_user_id', emp.auth_user_id).maybeSingle();
      return r1.data || null;
    }
    if (emp.email) {
      var bid = emp.business_id || (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current());
      if (!bid) return null;
      var r2 = await sb.from('users').select('id, role, manager_permissions').eq('business_id', bid).eq('email', emp.email).maybeSingle();
      return r2.data || null;
    }
  } catch (e) { console.warn('[managerAccess] role lookup failed', e); }
  return null;
}

// Grants or revokes manager-tier access for one employee. See this
// block's own header comment for the guard rules.
async function _pentaSetManagerAccess(emp, enable) {
  if (!_pentaIsOwnerOrAdmin()) {
    alert('Only an owner or admin can change manager access.');
    return false;
  }
  var blob = (typeof _pentaParseAuthToken === 'function') ? _pentaParseAuthToken() : null;
  var viewerAuthId = blob && blob.user && blob.user.id;
  if (emp.auth_user_id && viewerAuthId && emp.auth_user_id === viewerAuthId) {
    alert("You can't change your own access.");
    return false;
  }
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { alert('Supabase client not ready. Reload and try again.'); return false; }

  try {
    var existing = await _pentaFetchUserRoleRow(emp);

    if (!enable) {
      if (!existing) return true; // already employee-only, nothing to do
      if (existing.role === 'owner' || existing.role === 'admin') {
        alert("This person is an owner/admin -- manager access can't be changed here.");
        return false;
      }
      var off = await sb.from('users').update({ role: 'employee' }).eq('id', existing.id);
      if (off.error) { alert('Could not turn off manager access: ' + off.error.message); return false; }
      return true;
    }

    // Turning ON.
    if (existing) {
      if (existing.role === 'owner' || existing.role === 'admin') {
        alert('This person already has owner/admin access.');
        return true;
      }
      var on = await sb.from('users').update({ role: 'manager' }).eq('id', existing.id);
      if (on.error) { alert('Could not grant manager access: ' + on.error.message); return false; }
      return true;
    }

    var bid = emp.business_id || (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current());
    if (!bid) { alert('Could not resolve business -- reload and try again.'); return false; }

    var firstN = emp.first_name || (emp.name || '').split(' ')[0] || '';
    var lastN = emp.last_name || ((emp.name || '').split(' ').slice(1).join(' ')) || '-';
    // Same synthetic-email fallback saveStaffEmployee's own manager-row
    // creation already uses -- email here is just a stable row
    // identifier, never the real invite channel (that's always SMS,
    // handled below).
    var email = emp.email || (String(firstN).toLowerCase() + '.' + String(lastN).toLowerCase().replace(/\\s+/g, '') + '@managers.penta.internal');

    var userRow = {
      business_id: bid,
      email: email,
      first_name: firstN,
      last_name: lastN,
      phone: (emp.phone || '').replace(/\\D/g, '') || null,
      role: 'manager',
      manager_permissions: {}
    };
    if (emp.auth_user_id) {
      userRow.id = emp.auth_user_id;
      userRow.auth_user_id = emp.auth_user_id;
    }
    var ins = await sb.from('users').insert(userRow).select().maybeSingle();
    if (ins.error) { alert('Could not grant manager access: ' + ins.error.message); return false; }

    if (!emp.auth_user_id) {
      // No login yet -- the real invite channel is SMS (send-invite
      // Edge Function), which needs a phone number. Ask for ONLY that
      // if it's missing -- no questionnaire.
      if (!emp.phone) {
        var ph = prompt('No phone number on file for ' + (firstN || 'this employee') + ' yet -- the invite text needs one. Enter her phone number:');
        if (!ph) {
          alert('Manager access was saved, but no invite was sent yet -- add a phone number and tap Send Invite in the Penta Login section below.');
          return true;
        }
        var cleanedPh = ph.replace(/\\D/g, '');
        try { await window.PentaEmployees.update(emp.id, { phone: cleanedPh }); } catch (e) { console.warn('[managerAccess] phone save failed', e); }
        emp.phone = cleanedPh;
      }
      try {
        var rid = emp.legacy_roster_id || emp.id || emp.name;
        if (typeof pentaSendInvite === 'function') await pentaSendInvite(rid);
      } catch (e) { console.warn('[managerAccess] invite send failed', e); }
    }
    return true;
  } catch (e) {
    alert('Manager access change failed: ' + (e.message || e));
    return false;
  }
}

// Shared paint+wire for the "Manager access" section -- used by both
// the Staff View tab (data-attribute-located elements, dynamic per
// roster id) and the Edit tab (fixed-id elements, one instance reused
// across whichever employee is currently open).
async function _renderManagerAccessSection(emp, els) {
  if (!els || !els.statusEl) return;
  if (els.wrapEl) els.wrapEl.style.display = 'block';
  els.statusEl.textContent = 'Loading…';
  if (els.toggleWrap) els.toggleWrap.style.display = 'none';
  if (els.permLinkEl) els.permLinkEl.style.display = 'none';

  var viewerIsOwnerOrAdmin = _pentaIsOwnerOrAdmin();
  var blob = (typeof _pentaParseAuthToken === 'function') ? _pentaParseAuthToken() : null;
  var viewerAuthId = blob && blob.user && blob.user.id;
  var isSelf = !!(emp.auth_user_id && viewerAuthId && emp.auth_user_id === viewerAuthId);

  var row = await _pentaFetchUserRoleRow(emp);
  var role = row && row.role;

  if (role === 'owner' || role === 'admin') {
    els.statusEl.textContent = (role === 'owner' ? 'Owner' : 'Admin') + ' — full access. Not changeable here.';
    return;
  }

  var hasManagerAccess = role === 'manager';
  els.statusEl.textContent = hasManagerAccess ? 'Manager access: ON (full access, same as every manager today)' : 'Employee access only.';

  if (!viewerIsOwnerOrAdmin || isSelf) {
    if (isSelf) els.statusEl.textContent += ' You can\\u2019t change your own access.';
    return;
  }

  if (els.toggleWrap) els.toggleWrap.style.display = 'flex';
  if (els.toggleEl) {
    els.toggleEl.checked = hasManagerAccess;
    els.toggleEl.onchange = async function () {
      var turningOn = els.toggleEl.checked;
      els.toggleEl.disabled = true;
      var ok = await _pentaSetManagerAccess(emp, turningOn);
      els.toggleEl.disabled = false;
      if (!ok) { els.toggleEl.checked = !turningOn; return; }
      _renderManagerAccessSection(emp, els);
    };
  }
  if (els.permLinkEl && hasManagerAccess) els.permLinkEl.style.display = 'block';
}

function renderStaffView() {"""

EDITS = [
    ("Stage 1: add Manager Access helper functions before renderStaffView", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
