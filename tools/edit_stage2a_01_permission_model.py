#!/usr/bin/env python3
"""Stage 2a -- PART 1. The permission model itself: new manager
permission keys (all defaulting true, so existing managers with no
saved permissions keep exactly today's access -- the existing
DEFAULT_PERMISSIONS/getPermissions/isPermitted convention from Stage 0
already guarantees "missing key = true"), the preset payloads, and the
_pentaCan/_pentaVisibleTeams/_pentaCanSeeTeam helpers every enforcement
site in this stage calls instead of a direct role check.

Nothing here needs a migration -- manager_permissions is an existing
jsonb column (migration 023), so new keys just work the moment this
code ships, before any Stage 2b migration is applied. The ONLY part of
Stage 2 that needs 2b is making "Do" actions and pay rates impossible
to bypass via a direct API call -- that's a separate PR.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """var DEFAULT_PERMISSIONS = {
  manager: {
    analytics_icon: true, churn_icon: true, inbox_icon: true,
    rewards_icon: true, assets_icon: true, inventory_icon: true,
    content_icon: true, quote_icon: true, approval_icon: true,
    route_icon: true, files_icon: true, updates_icon: true,
    school_icon: true, crm_icon: true, new_client_icon: true,
    ratings_icon: true,
    admin_phase3c: true,
    admin_phase3d: true,
    admin_hours_report: true,
    preview_as_employee: true,
    learn: true,
    send_employee_banner: true,
    send_employee_invites: true,
    set_employee_password: true
  },"""

NEW = """// Stage 2: Schedule-screen + Claire permission keys (all true here --
// this is the "missing key = full access" fallback every EXISTING
// manager with no saved manager_permissions still gets). A restricted
// manager has some of these explicitly set to false in her own DB row;
// see PRESET_PERMISSIONS below for the payloads the "Manager
// Permissions" panel writes.
//
// teams_visible is NOT a boolean like the others -- it's an array of
// team name strings (job.team's own values, e.g. 'B3'), or absent/null,
// which means "all teams" (matches today's behavior for everyone who
// has never had this set). _pentaCanSeeTeam() is the one place that
// interprets it; every schedule/Hours/Team-Assignments/Claire surface
// that lists or counts by team calls through that function rather than
// reading manager_permissions.teams_visible directly.
var SCHEDULE_PERMISSION_DEFAULTS = {
  see_schedule: true,
  see_revenue_total: true,
  see_day_revenue: true,
  see_team_revenue: true,
  see_job_price: true,
  see_client_contact: true,
  see_close_day_button: true,
  see_team_assignments: true,
  see_hours_tab: true,
  see_payroll: true,
  see_exports: true,
  see_claire_tab: true,
  do_add_job: true,
  do_edit_job: true,
  do_move_job: true,
  do_cancel_job: true,
  do_assign_teams: true,
  do_change_price: true,
  do_record_payment: true,
  do_close_day: true,
  do_edit_hours: true,
  do_invite_promote: true
};

// Payloads the "Manager Permissions" panel's preset buttons write to
// users.manager_permissions. Every preset is written as EXPLICIT keys
// (true where it differs from the all-true default would matter, false
// where restricted) -- never as "delete the restricting keys," so a
// preset always produces the same result regardless of what was there
// before. "Full manager" / "Owner (everything)" both resolve to {}
// (nothing restricted) -- this panel only ever sets role='manager' (see
// Stage 1), so "Owner (everything)" sets PERMISSIONS only, same as Full
// manager; it can never make someone an actual owner. The UI says this
// plainly so it's never misread as a role change.
var PRESET_PERMISSIONS = {
  owner_everything: {},
  full_manager: {},
  office_manager: {
    see_revenue_total: false, see_day_revenue: false, see_team_revenue: false,
    see_job_price: false, see_payroll: false,
    see_close_day_button: false, do_close_day: false
  },
  view_only_schedule: {
    see_revenue_total: false, see_day_revenue: false, see_team_revenue: false,
    see_job_price: false, see_payroll: false, see_exports: false,
    see_close_day_button: false,
    do_add_job: false, do_edit_job: false, do_move_job: false, do_cancel_job: false,
    do_assign_teams: false, do_change_price: false, do_record_payment: false,
    do_close_day: false, do_edit_hours: false, do_invite_promote: false
  },
  limited_manager: {
    see_revenue_total: false, see_day_revenue: false, see_team_revenue: false,
    see_job_price: false, see_payroll: false, see_exports: false,
    see_close_day_button: false,
    do_add_job: false, do_edit_job: false, do_move_job: false, do_cancel_job: false,
    do_assign_teams: false, do_change_price: false, do_record_payment: false,
    do_close_day: false, do_invite_promote: false,
    teams_visible: []
  }
};
var PRESET_LABELS = [
  { key: 'owner_everything',  label: 'Owner (everything)', note: 'Sets permissions only -- does not change her role.' },
  { key: 'full_manager',      label: 'Full manager',        note: 'Same access as any manager today.' },
  { key: 'office_manager',    label: 'Office manager',      note: 'Everything except revenue, pay, and Close Day.' },
  { key: 'view_only_schedule', label: 'View-only schedule', note: 'Can see the schedule; cannot change anything.' },
  { key: 'limited_manager',   label: 'Limited manager',     note: 'No revenue, no pay, no Close Day, no add/edit/cancel. Pick which teams she can see below.' },
  { key: 'grokbot',           label: 'Grokbot',             note: 'Coming in Stage 3.', disabled: true }
];

function _pentaScheduleDefaultPerms() { return Object.assign({}, SCHEDULE_PERMISSION_DEFAULTS); }

// Single choke point every enforcement site in this stage calls instead
// of a direct role/manager_permissions check. Owner/admin always true
// (getPermissions() already returns all-true for them).
function _pentaCan(key) {
  var perms = getPermissions();
  var manager = Object.assign({}, SCHEDULE_PERMISSION_DEFAULTS, perms.manager || {});
  return manager[key] !== false;
}

// null = all teams visible (today's behavior, and every existing
// manager who has never had this set). An array restricts to exactly
// those team name strings.
function _pentaVisibleTeams() {
  var perms = getPermissions();
  var tv = perms.manager && perms.manager.teams_visible;
  return Array.isArray(tv) ? tv : null;
}
function _pentaCanSeeTeam(teamName) {
  var visible = _pentaVisibleTeams();
  if (visible === null) return true;
  if (!teamName) return true;
  return visible.indexOf(teamName) !== -1;
}
// Convenience for list/report code that needs to drop hidden-team rows
// out of an array of {team: '...'} -shaped objects (jobs, assignments,
// hours rows) in one line instead of repeating the filter predicate.
function _pentaFilterVisibleTeams(items, teamKey) {
  teamKey = teamKey || 'team';
  if (_pentaVisibleTeams() === null) return items;
  return (items || []).filter(function (it) { return _pentaCanSeeTeam(it && it[teamKey]); });
}

var DEFAULT_PERMISSIONS = {
  manager: {
    analytics_icon: true, churn_icon: true, inbox_icon: true,
    rewards_icon: true, assets_icon: true, inventory_icon: true,
    content_icon: true, quote_icon: true, approval_icon: true,
    route_icon: true, files_icon: true, updates_icon: true,
    school_icon: true, crm_icon: true, new_client_icon: true,
    ratings_icon: true,
    admin_phase3c: true,
    admin_phase3d: true,
    admin_hours_report: true,
    preview_as_employee: true,
    learn: true,
    send_employee_banner: true,
    send_employee_invites: true,
    set_employee_password: true,
    // Stage 2 schedule/Claire/payroll permission keys, merged in here
    // too so any existing code that reads DEFAULT_PERMISSIONS.manager
    // directly (rather than through _pentaCan) still sees them.
    see_schedule: true, see_revenue_total: true, see_day_revenue: true,
    see_team_revenue: true, see_job_price: true, see_client_contact: true,
    see_close_day_button: true, see_team_assignments: true, see_hours_tab: true,
    see_payroll: true, see_exports: true, see_claire_tab: true,
    do_add_job: true, do_edit_job: true, do_move_job: true, do_cancel_job: true,
    do_assign_teams: true, do_change_price: true, do_record_payment: true,
    do_close_day: true, do_edit_hours: true, do_invite_promote: true
  },"""

EDITS = [
    ("Stage 2a: add the schedule permission model, presets, and _pentaCan/_pentaCanSeeTeam helpers", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
