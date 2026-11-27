#!/usr/bin/env python3
"""manage-permissions-button-fix -- PART 3. _renderManagerAccessSection
awaited _pentaFetchUserRoleRow with no timeout and no try/catch -- a
stalled network call left the section stuck on "Loading..." forever.
Races it against an 18s timeout (same _pentaWithTimeout helper the
login-hang-fix task already added) and shows a clear, tappable-to-retry
error instead. Also adds the current-preset line Tom asked for, so he
can see what she has without opening the Permissions panel.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function _renderManagerAccessSection(emp, els) {
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
  els.statusEl.textContent = hasManagerAccess ? 'Manager access: ON (full access, same as every manager today)' : 'Employee access only.';"""

NEW = """async function _renderManagerAccessSection(emp, els) {
  if (!els || !els.statusEl) return;
  if (els.wrapEl) els.wrapEl.style.display = 'block';
  els.statusEl.textContent = 'Loading…';
  if (els.toggleWrap) els.toggleWrap.style.display = 'none';
  if (els.permLinkEl) els.permLinkEl.style.display = 'none';

  var viewerIsOwnerOrAdmin = _pentaIsOwnerOrAdmin();
  var blob = (typeof _pentaParseAuthToken === 'function') ? _pentaParseAuthToken() : null;
  var viewerAuthId = blob && blob.user && blob.user.id;
  var isSelf = !!(emp.auth_user_id && viewerAuthId && emp.auth_user_id === viewerAuthId);

  // manage-permissions-button-fix: a stalled network call used to leave
  // this stuck on "Loading..." forever, with no way to tell it apart
  // from a slow-but-working load. Race it against a timeout and show a
  // clear, tappable-to-retry message instead.
  var row;
  try {
    row = (typeof _pentaWithTimeout === 'function')
      ? await _pentaWithTimeout(_pentaFetchUserRoleRow(emp), 18000)
      : await _pentaFetchUserRoleRow(emp);
  } catch (e) {
    var _timedOut = e && e.message === 'penta-login-timeout';
    els.statusEl.innerHTML = '';
    els.statusEl.textContent = _timedOut
      ? "Couldn't load access status: taking too long to respond. Tap to retry."
      : "Couldn't load access status: " + (e && e.message || 'unknown error') + '. Tap to retry.';
    els.statusEl.style.cursor = 'pointer';
    els.statusEl.onclick = function () { _renderManagerAccessSection(emp, els); };
    return;
  }
  var role = row && row.role;

  if (role === 'owner' || role === 'admin') {
    els.statusEl.textContent = (role === 'owner' ? 'Owner' : 'Admin') + ' — full access. Not changeable here.';
    return;
  }

  var hasManagerAccess = role === 'manager';
  els.statusEl.textContent = hasManagerAccess
    ? ('Manager access: ON — ' + _pentaDescribePreset(row && row.manager_permissions))
    : 'Employee access only.';"""

EDITS = [
    ("manage-permissions-button-fix: timeout + error handling + current-preset label in _renderManagerAccessSection", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
