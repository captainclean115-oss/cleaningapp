#!/usr/bin/env python3
"""Terminated-employee date-awareness fix -- employee portal login
gate. Blocks login only on/after her exclusion date (using TODAY, in
business timezone -- a login check has no "viewed date" the way a
report does), so a future-dated termination doesn't lock her out
before that date arrives. Deliberately fails toward BLOCKED when
terminated_at is missing (the opposite of getUnifiedRoster's own
"fails toward shown" default for historical views) -- this is a
security/access-control gate (PR #149's own finding: "a real,
exploitable access-control gap, not a display nicety"), so an
ambiguous case must not let a terminated employee back in.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "add terminated_at to the boot employee-resolution select + returned object",
        """        var res = await sb.from('employees')
          .select('id, legacy_roster_id, first_name, last_name, team_text, team_id, culture_tag, position, photo_url, status, auth_user_id, work_type, pay_type')
          .eq('auth_user_id', authId)""",
        """        var res = await sb.from('employees')
          .select('id, legacy_roster_id, first_name, last_name, team_text, team_id, culture_tag, position, photo_url, status, terminated_at, auth_user_id, work_type, pay_type')
          .eq('auth_user_id', authId)""",
    ),
    (
        "return terminated_at in the resolved employee object",
        """          status: m.status || 'active',
          role: [],
          position: m.position || 'team_member',""",
        """          status: m.status || 'active',
          terminated_at: m.terminated_at || null,
          role: [],
          position: m.position || 'team_member',""",
    ),
    (
        "add _bootIsTerminatedLoginBlocked helper before _bootResolveEmployeeFromAuth",
        """  function _bootResolveEmployeeFromAuth(parsed) {""",
        """  // Terminated-employee date-awareness fix. Mirrors getUnifiedRoster's
  // own isTerminatedAsOf comparison, but fails toward BLOCKED (not
  // shown) when terminated_at is missing -- deliberately the opposite
  // default from the historical-display contexts, since this gates
  // live portal access, not a report.
  function _bootIsTerminatedLoginBlocked(emp) {
    if (!emp || emp.status !== 'terminated') return false;
    if (!emp.terminated_at) return true;
    var p = _bizTodayParts(_pentaBusinessTimezone());
    var todayKey = p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
    return todayKey >= emp.terminated_at;
  }

  function _bootResolveEmployeeFromAuth(parsed) {""",
    ),
    (
        "call site 1: use the date-aware login-block check",
        """          var emp = await _bootResolveEmployeeFromAuth(_sbParsed);
          // PR #149: status was already fetched/returned here but never
          // checked -- any employee with valid Supabase auth credentials
          // could log into the portal indefinitely after termination.
          if (emp && emp.status === 'terminated') {
            _bootShowTerminatedAccountMessage();
          } else if (emp) {""",
        """          var emp = await _bootResolveEmployeeFromAuth(_sbParsed);
          // PR #149: status was already fetched/returned here but never
          // checked -- any employee with valid Supabase auth credentials
          // could log into the portal indefinitely after termination.
          // Terminated-employee date-awareness fix: _bootIsTerminatedLoginBlocked
          // only blocks on/after her actual termination date (today, business
          // timezone) -- a future-dated termination must not lock her out early.
          if (_bootIsTerminatedLoginBlocked(emp)) {
            _bootShowTerminatedAccountMessage();
          } else if (emp) {""",
    ),
    (
        "call site 2: use the date-aware login-block check (fallback path)",
        """            var emp2 = await _bootResolveEmployeeFromAuth(_sbParsed);
            if (emp2 && emp2.status === 'terminated') _bootShowTerminatedAccountMessage();
            else if (emp2) appUnlockEmployee(emp2);""",
        """            var emp2 = await _bootResolveEmployeeFromAuth(_sbParsed);
            if (_bootIsTerminatedLoginBlocked(emp2)) _bootShowTerminatedAccountMessage();
            else if (emp2) appUnlockEmployee(emp2);""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
