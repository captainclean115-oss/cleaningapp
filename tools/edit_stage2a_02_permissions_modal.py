#!/usr/bin/env python3
"""Stage 2a -- PART 2. The "Manager Permissions" panel: presets +
grouped See/Do toggles + a team multi-select, opened from the "Manage
permissions" link the previous edit added to the Manager Access
section. Same owner/admin-only + not-self guards as _pentaSetManagerAccess.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function renderStaffView() {"""

NEW = """// Stage 2: the "Manager Permissions" panel. Presets apply instantly to
// the in-memory checkbox state (not saved until Save is tapped), so
// Tom can start from a preset and still hand-tweak individual items.
async function openManagerPermissionsModal(emp) {
  if (!_pentaIsOwnerOrAdmin()) { alert('Only an owner or admin can change permissions.'); return; }
  var blob = (typeof _pentaParseAuthToken === 'function') ? _pentaParseAuthToken() : null;
  var viewerAuthId = blob && blob.user && blob.user.id;
  if (emp.auth_user_id && viewerAuthId && emp.auth_user_id === viewerAuthId) {
    alert("You can't change your own permissions.");
    return;
  }
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { alert('Supabase client not ready. Reload and try again.'); return; }

  var existing = await _pentaFetchUserRoleRow(emp);
  if (!existing || existing.role !== 'manager') {
    alert('Grant manager access first, then set permissions.');
    return;
  }

  var savedPerms = existing.manager_permissions || {};
  var perms = Object.assign({}, SCHEDULE_PERMISSION_DEFAULTS, savedPerms);
  var teamsVisible = Array.isArray(savedPerms.teams_visible) ? savedPerms.teams_visible.slice() : null; // null = all

  var SEE_ITEMS = [
    ['see_schedule', 'See the schedule tab'],
    ['see_revenue_total', 'See revenue total (top of schedule)'],
    ['see_day_revenue', 'See revenue under each day'],
    ['see_team_revenue', 'See revenue under each team'],
    ['see_job_price', 'See client price on job cards'],
    ['see_client_contact', 'See client phone/address/notes'],
    ['see_close_day_button', 'See the Close Day button'],
    ['see_team_assignments', 'See Team Assignments'],
    ['see_hours_tab', 'See the Hours tab'],
    ['see_payroll', 'See pay rates / payroll'],
    ['see_exports', 'See export buttons / Team Day Report'],
    ['see_claire_tab', 'See the Claire tab']
  ];
  var DO_ITEMS = [
    ['do_add_job', 'Add a job'],
    ['do_edit_job', 'Edit a job'],
    ['do_move_job', 'Move a job'],
    ['do_cancel_job', 'Cancel / uncancel a job'],
    ['do_assign_teams', 'Assign teams'],
    ['do_change_price', 'Change prices'],
    ['do_record_payment', 'Record payments'],
    ['do_close_day', 'Run Close Day'],
    ['do_edit_hours', 'Edit hours'],
    ['do_invite_promote', 'Invite / promote people']
  ];

  function toggleRow(key, label) {
    var checked = perms[key] !== false;
    return '<label style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);cursor:pointer">'
      + '<span style="font-size:13px">' + label + '</span>'
      + '<input type="checkbox" data-perm-key="' + key + '"' + (checked ? ' checked' : '') + ' style="width:19px;height:19px;accent-color:var(--accent)">'
      + '</label>';
  }

  var teamNames = (typeof _pentaTeamNames === 'function') ? _pentaTeamNames() : [];
  var teamsHtml = teamNames.map(function (t) {
    var checked = (teamsVisible === null) || teamsVisible.indexOf(t) !== -1;
    return '<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">'
      + '<input type="checkbox" data-team-visible="' + t + '"' + (checked ? ' checked' : '') + ' style="width:17px;height:17px;accent-color:var(--accent)">'
      + '<span style="font-size:13px">' + t + '</span>'
      + '</label>';
  }).join('');

  var presetsHtml = PRESET_LABELS.map(function (p) {
    return '<button type="button" data-preset-key="' + p.key + '"' + (p.disabled ? ' disabled' : '') + ' style="display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;cursor:' + (p.disabled ? 'not-allowed' : 'pointer') + ';opacity:' + (p.disabled ? '0.5' : '1') + '">'
      + '<div style="font-size:13px;font-weight:600">' + p.label + '</div>'
      + '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + p.note + '</div>'
      + '</button>';
  }).join('');

  var modal = document.createElement('div');
  modal.id = 'mgr-perms-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.85);display:flex;align-items:flex-end';
  modal.onclick = function (e) { if (e.target === modal) modal.remove(); };
  var sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--surface);width:100%;max-height:92vh;overflow-y:auto;border-radius:16px 16px 0 0;border-top:1px solid var(--border2)';
  sheet.innerHTML = '<div style="padding:18px 20px 14px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:1;display:flex;justify-content:space-between;align-items:center">'
    + '<div><div style="font-size:18px;font-weight:700">Manager Permissions — ' + _escapeHtmlMgr(emp.name || '') + '</div><div style="font-size:12px;color:var(--muted);margin-top:2px">Presets set permissions only — they never change her role.</div></div>'
    + '<button onclick="document.getElementById(\\'mgr-perms-modal\\').remove()" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer">×</button>'
    + '</div>'
    + '<div style="padding:16px 20px 32px">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:8px">Presets</div>'
    + presetsHtml
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:18px 0 8px">See</div>'
    + SEE_ITEMS.map(function (x) { return toggleRow(x[0], x[1]); }).join('')
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:18px 0 8px">Do</div>'
    + DO_ITEMS.map(function (x) { return toggleRow(x[0], x[1]); }).join('')
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:18px 0 8px">Which teams can she see</div>'
    + '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">All teams are visible unless you uncheck any below.</div>'
    + teamsHtml
    + '<div id="mgr-perms-save-msg" style="margin-top:14px;font-size:13px;min-height:18px"></div>'
    + '<button type="button" id="mgr-perms-save-btn" style="width:100%;margin-top:6px;padding:14px;background:var(--accent);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">Save</button>'
    + '</div>';
  modal.appendChild(sheet);
  document.body.appendChild(modal);

  Array.prototype.forEach.call(sheet.querySelectorAll('[data-preset-key]'), function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-preset-key');
      var preset = PRESET_PERMISSIONS[key];
      if (!preset) return; // grokbot placeholder, disabled anyway
      var merged = Object.assign({}, SCHEDULE_PERMISSION_DEFAULTS, preset);
      Array.prototype.forEach.call(sheet.querySelectorAll('[data-perm-key]'), function (cb) {
        cb.checked = merged[cb.getAttribute('data-perm-key')] !== false;
      });
      var presetTeams = Array.isArray(preset.teams_visible) ? preset.teams_visible : null;
      Array.prototype.forEach.call(sheet.querySelectorAll('[data-team-visible]'), function (cb) {
        cb.checked = presetTeams === null ? true : presetTeams.indexOf(cb.getAttribute('data-team-visible')) !== -1;
      });
    });
  });

  document.getElementById('mgr-perms-save-btn').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    var msgEl = document.getElementById('mgr-perms-save-msg');
    var newPerms = {};
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-perm-key]'), function (cb) {
      newPerms[cb.getAttribute('data-perm-key')] = cb.checked;
    });
    var checkedTeams = [];
    var uncheckedAny = false;
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-team-visible]'), function (cb) {
      if (cb.checked) checkedTeams.push(cb.getAttribute('data-team-visible'));
      else uncheckedAny = true;
    });
    // "all checked" is stored as "no teams_visible key at all" -- same
    // meaning as a manager who's never had this set.
    if (uncheckedAny) newPerms.teams_visible = checkedTeams;

    try {
      var up = await sb.from('users').update({ manager_permissions: newPerms }).eq('id', existing.id);
      if (up.error) { msgEl.textContent = 'Could not save: ' + up.error.message; msgEl.style.color = 'var(--red)'; btn.disabled = false; return; }
      msgEl.textContent = '✓ Saved. Takes effect on her next screen load.';
      msgEl.style.color = 'var(--green)';
      setTimeout(function () { modal.remove(); }, 900);
    } catch (e) {
      msgEl.textContent = 'Save failed: ' + (e.message || e);
      msgEl.style.color = 'var(--red)';
      btn.disabled = false;
    }
  });
}

function renderStaffView() {"""

EDITS = [
    ("Stage 2a: add the Manager Permissions modal", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
