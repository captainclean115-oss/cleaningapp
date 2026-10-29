#!/usr/bin/env python3
"""Claire portal-links update, step 2: new eligibility checks in
_claireSendPortalLinks's considerFull(), surfaced in the PREVIEW step
(before any send), not just discovered after a failed attempt:

- invalid phone (distinct from "no phone on file") -- a non-empty but
  non-normalizable phone currently sails through eligibility and only
  fails confusingly at send time.
- phone_already_registered collision -- mirrors send-invite's own
  server-side findPhoneCollision (PR #205), copied client-side (not
  re-derived differently) using data already loaded via
  PentaEmployees.listSync(). Catches a STALE registered identity (any
  status, not just active) squatting on this phone's derived email --
  broader than the existing active-vs-active duplicate-phone check,
  which only compares CURRENT phones among ACTIVE employees.
- login-out-of-sync-with-phone (reset only) -- flags a stored email
  that IS phone-derived-shaped, just for a DIFFERENT number than the
  current one. Deliberately does NOT flag the many pre-phone-derived-
  convention name-based emails (Blanca, Melissa, Nadia, Viviana, etc.)
  -- those are a different, healthy shape, not evidence of drift.
  This still cannot catch every real case: an employee whose
  employees.email was already corrected to match her phone but whose
  real auth.users.email is still stale looks "in sync" from here --
  the client has no way to read the real auth email at all. Flagged
  in the PR description, not solved with a new server path.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD_HEADER = """async function _claireSendPortalLinks(input, kind) {
  var sendFn = (kind === 'invite') ? pentaSendInvite : pentaSendPasswordReset;
  var names = Array.isArray(input.employees) ? input.employees.filter(Boolean) : [];
  var wantAll = input.all === true;
  if (!wantAll && !names.length) {
    return { error: { kind: 'no_employees_specified' } };
  }

  var resolved = [];
  var skipped = [];

  function considerFull(full, queriedName) {
    if (!full) { skipped.push({ name: queriedName, reason: 'could not load this employee\\'s record.' }); return; }
    if (full.status === 'terminated') { skipped.push({ name: full.name || queriedName, reason: 'terminated.' }); return; }
    if (!full.phone) { skipped.push({ name: full.name || queriedName, reason: 'no phone on file.' }); return; }
    var dupReason = _findDuplicateActivePhoneOwnerReason(full);
    if (dupReason) { skipped.push({ name: full.name || queriedName, reason: dupReason }); return; }
    if (kind === 'invite' && full.auth_user_id) { skipped.push({ name: full.name || queriedName, reason: 'already has a login.' }); return; }
    if (kind === 'reset' && !full.auth_user_id) { skipped.push({ name: full.name || queriedName, reason: 'no login yet -- send an invite instead.' }); return; }
    resolved.push({ rosterId: full.legacy_roster_id || full.id, uuid: full.id, name: full.name || queriedName });
  }"""

NEW_HEADER = """// Shared normalize, used by every one of _claireSendPortalLinks's own
// eligibility checks below -- same algorithm as normalizePhone
// everywhere else in this app (send-invite, phone-login, etc.),
// copied rather than re-derived differently.
function _claireNormalizePhone(raw) {
  var digits = String(raw || '').replace(/\\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

// Invite-collision guard, client-side preview mirror of send-invite's
// own server-side findPhoneCollision (PR #205) -- copied, not
// re-derived differently, using data already loaded via
// PentaEmployees.listSync() so Claire can surface this in the PREVIEW
// step, before any text is sent, not just after a failed attempt.
// Any OTHER employee row (ANY status, including terminated -- a stale
// fixture row can still be squatting on a real login) that ALREADY
// has a login whose stored email or phone matches this one's derived
// target.
function _claireFindPhoneCollision(emp) {
  try {
    var normalized = _claireNormalizePhone(emp.phone);
    if (!normalized) return null;
    var derivedEmail = normalized + '@phone.penta.internal';
    var all = (window.PentaEmployees && window.PentaEmployees.listSync) ? window.PentaEmployees.listSync() : [];
    for (var i = 0; i < all.length; i++) {
      var row = all[i];
      if (!row || row.id === emp.id || !row.auth_user_id) continue;
      var rowEmail = String(row.email || '').toLowerCase();
      var rowNormalized = _claireNormalizePhone(row.phone);
      if (rowEmail === derivedEmail || (rowNormalized && rowNormalized === normalized)) return row;
    }
    return null;
  } catch (e) {
    console.warn('[_claireFindPhoneCollision] check failed (non-fatal, treated as no collision)', e);
    return null;
  }
}

// Reset-only: a linked employee whose stored email IS phone-derived-
// shaped, just for a DIFFERENT number than her current one -- see this
// script's own header comment for why pre-convention name-based
// emails are deliberately excluded, and what this still can't catch.
function _claireLoginOutOfSync(emp) {
  if (!emp || !emp.auth_user_id) return false;
  try {
    var normalized = _claireNormalizePhone(emp.phone);
    if (!normalized) return false;
    var derivedEmail = normalized + '@phone.penta.internal';
    var stored = String(emp.email || '').toLowerCase();
    return /^\\d{10}@phone\\.penta\\.internal$/.test(stored) && stored !== derivedEmail;
  } catch (e) { return false; }
}

async function _claireSendPortalLinks(input, kind) {
  var sendFn = (kind === 'invite') ? pentaSendInvite : pentaSendPasswordReset;
  var names = Array.isArray(input.employees) ? input.employees.filter(Boolean) : [];
  var wantAll = input.all === true;
  if (!wantAll && !names.length) {
    return { error: { kind: 'no_employees_specified' } };
  }

  var resolved = [];
  var skipped = [];

  function considerFull(full, queriedName) {
    if (!full) { skipped.push({ name: queriedName, reason: 'could not load this employee\\'s record.' }); return; }
    if (full.status === 'terminated') { skipped.push({ name: full.name || queriedName, reason: 'terminated.' }); return; }
    if (!full.phone) { skipped.push({ name: full.name || queriedName, reason: 'no phone on file.' }); return; }
    if (!_claireNormalizePhone(full.phone)) { skipped.push({ name: full.name || queriedName, reason: 'invalid phone on file.' }); return; }
    var dupReason = _findDuplicateActivePhoneOwnerReason(full);
    if (dupReason) { skipped.push({ name: full.name || queriedName, reason: dupReason }); return; }
    if (_claireFindPhoneCollision(full)) {
      skipped.push({ name: full.name || queriedName, reason: 'this phone number is already registered to another login, correct the phone in Staff first.' });
      return;
    }
    if (kind === 'invite' && full.auth_user_id) { skipped.push({ name: full.name || queriedName, reason: 'already has a login.' }); return; }
    if (kind === 'reset' && !full.auth_user_id) { skipped.push({ name: full.name || queriedName, reason: 'no login yet -- send an invite instead.' }); return; }
    if (kind === 'reset' && _claireLoginOutOfSync(full)) { skipped.push({ name: full.name || queriedName, reason: 'login out of sync with phone, use Fix login in Staff first.' }); return; }
    resolved.push({ rosterId: full.legacy_roster_id || full.id, uuid: full.id, name: full.name || queriedName });
  }"""

apply_edits([
    ("_claireSendPortalLinks: add invalid-phone, collision, and out-of-sync eligibility checks", OLD_HEADER, NEW_HEADER),
])
