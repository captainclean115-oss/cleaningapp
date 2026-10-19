#!/usr/bin/env python3
"""Published Hours feature. Manager-side visibility for the same gap the
portal's own distinct error message covers: a banner on the Staff screen
listing every ACTIVE employee with no auth_user_id link at all -- they
cannot use the employee portal, see Published Hours, or get the red
"not linked" message (they can't log in to trigger it in the first
place). Confirmed live via a read-only query: 20 of Manna's 25 active
employees are in this state today (most haven't been invited to the new
auth system yet) -- this is expected mid-rollout, not necessarily a bug,
but worth surfacing so it's a visible, countable fact rather than silent.
Does not touch getStaffList()/the card renderer/any manager-facing hours
number -- purely an additional banner prepended to the existing render.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  let html = active.map((emp) => card(emp, list.indexOf(emp))).join('');
  if (terminated.length > 0) {"""

NEW = """  // Published Hours feature: active employees with no login account
  // linked at all -- distinct from "status === 'inactive'" above, and
  // distinct from the portal's own red "not linked" message (which only
  // a logged-in employee with a BROKEN link would ever see -- these
  // employees can't log in to the portal at all yet).
  var _noAuthLinkActive = list.filter(function (e) { return e.status === 'active' && !e.auth_user_id; });
  var _noAuthLinkBanner = _noAuthLinkActive.length
    ? '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#ef4444"><strong>'
      + _noAuthLinkActive.length + ' active employee' + (_noAuthLinkActive.length === 1 ? '' : 's') + ' not linked to a login account</strong> — they cannot use the employee portal or see Published Hours until invited: '
      + _noAuthLinkActive.map(function (e) { return e.name; }).join(', ') + '</div>'
    : '';

  let html = _noAuthLinkBanner + active.map((emp) => card(emp, list.indexOf(emp))).join('');
  if (terminated.length > 0) {"""

EDITS = [("renderStaffList: banner listing active employees with no auth link", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
