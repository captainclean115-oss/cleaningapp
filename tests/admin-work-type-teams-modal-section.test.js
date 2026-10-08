// Admin/Office employee designation (migration 113) -- Teams modal
// (renderTeamManager): Admin/Office employees must never appear in a
// team card or either Unassigned list, must get their own "Admin /
// Office" section at the bottom with Off/Vacation available but no
// team Move/Assign buttons, and a bad admin row must degrade to an
// error card instead of blanking the team cards/Unassigned/Archived
// sections above it (PR #182/#146 pattern).
//
// Run against the REAL extracted renderTeamManager -- not a
// reimplementation.
//
// Run with: node tests/admin-work-type-teams-modal-section.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find "' + startMarker + '" (' + label + ')'); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end boundary for ' + label); process.exit(1); }
  return src.slice(s, e);
}

const renderSrc = extract(
  'async function renderTeamManager(opts) {',
  '\n\n// GPS Vehicle assignment write',
  'renderTeamManager'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const DATE = '2026-10-08';

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [
    { id: 'e1', uuid: 'u1', name: 'Alice', defaultTeam: 'B1', role: [], work_type: 'field' },
    { id: 'e2', uuid: 'u2', name: 'Linda', defaultTeam: null, role: [], work_type: 'admin' },
    { id: 'e3', uuid: 'u3', name: 'Pat',   defaultTeam: null, role: [], work_type: 'field' }, // genuinely unassigned
  ];
  const termData = opts.termData || {};
  const contentEl = { innerHTML: '' };
  const dateEl = { value: DATE };
  const els = { 'team-mgr-date': dateEl, 'team-mgr-content': contentEl };

  const sandbox = {
    console,
    document: { getElementById: function (id) { return els[id] || null; } },
    window: {
      PentaEmployees: { listSync: function () { return roster; }, isReady: function () { return true; } },
      PentaAssignments: { ready: function () { return Promise.resolve(); } },
    },
    _tmgrGpsCache: { dateStr: null, devices: null, teamDeviceMap: null },
    _geotabCall: function () { return Promise.resolve([]); },
    _resolveTeamDeviceMap: function () { return Promise.resolve({}); },
    getUnifiedRoster: function () { return roster; },
    getRosterTermData: function () { return termData; },
    _pentaTeamNames: function () { return ['B1', 'S3']; },
    _pentaTeamColor: function (t, fallback) { return fallback || '#000'; },
    _teamDayStats: function () { return { mins: 0, revenue: 0, houses: 0 }; },
    _adminEsc: function (s) { return String(s == null ? '' : s); },
    dailyAssignments: opts.dailyAssignments || {},
    dailyAssignmentDetails: opts.dailyAssignmentDetails || {},
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },
    getEmployeeTeam: function (empId, dateStr) {
      var key = dateStr + '_' + empId;
      if (sandbox.dailyAssignments[key] !== undefined) {
        return sandbox.dailyAssignments[key] === 'OFF' ? null : sandbox.dailyAssignments[key];
      }
      var emp = roster.find(function (e) { return e.id === empId; });
      return emp ? emp.defaultTeam : null;
    },
    getEmployeeDayOffInfo: function (empId, dateStr) {
      var key = dateStr + '_' + empId;
      if (sandbox.dailyAssignments[key] !== 'OFF') return null;
      return sandbox.dailyAssignmentDetails[key] || null;
    },
    _adminEmpDayOff: opts.adminDayOffFn || function (empId, dateStr) {
      if (sandbox.dailyAssignments[dateStr + '_' + empId] !== 'OFF') return null;
      var info = sandbox.dailyAssignmentDetails[dateStr + '_' + empId] || null;
      var st = info && info.status_type;
      return { status_type: st || null, label: (st && sandbox.DAY_OFF_CATEGORY_LABELS[st]) || 'Off' };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(renderSrc, sandbox);
  return { sandbox, contentEl };
}

async function main() {
  // ---- Linda (Admin) never appears in a team card or either Unassigned list ----
  {
    const { sandbox, contentEl } = buildSandbox();
    await sandbox.renderTeamManager();
    const html = contentEl.innerHTML;

    check('Linda does not appear inside the B1 team card', /B1[\s\S]{0,400}Linda/.test(html.split('Admin / Office')[0]), false);
    check('an Unassigned section exists for Pat (genuinely teamless field employee)', /Unassigned[\s\S]{0,400}Pat/.test(html), true);
    const beforeAdminSection = html.split('Admin / Office')[0];
    check('Linda does NOT appear in the Unassigned section (only Pat should)', /Linda/.test(beforeAdminSection), false);
    check('a separate "Admin / Office" section exists', /🏢 Admin \/ Office/.test(html), true);
    check('Linda appears inside the Admin/Office section', /Admin \/ Office[\s\S]*Linda/.test(html), true);
  }

  // ---- Admin/Office section has Off but no Move/Assign button for Linda ----
  {
    const { sandbox, contentEl } = buildSandbox();
    await sandbox.renderTeamManager();
    const adminSection = contentEl.innerHTML.split('🏢 Admin / Office')[1] || '';
    check('the Admin/Office section has an Off button for Linda', /openDayOffPicker\('e2'/.test(adminSection), true);
    check('the Admin/Office section has an Edit button for Linda', /openRosterEmpEdit\('e2'/.test(adminSection), true);
    check('the Admin/Office section has NO "Move" button at all (no team to move between)', /Move/.test(adminSection), false);
    check('the Admin/Office section has NO quickAssign team pill for Linda', /quickAssign\('e2'/.test(adminSection), false);
  }

  // ---- Linda's vacation status shows in the Admin/Office section ----
  {
    const { sandbox, contentEl } = buildSandbox({
      dailyAssignments: { '2026-10-08_e2': 'OFF' },
      dailyAssignmentDetails: { '2026-10-08_e2': { status_type: 'vacation' } },
    });
    await sandbox.renderTeamManager();
    const adminSection = contentEl.innerHTML.split('🏢 Admin / Office')[1] || '';
    check('Linda\'s vacation badge shows in the Admin/Office section', /Vacation/.test(adminSection), true);
  }

  // ---- Terminated admin employees are excluded from Admin/Office,
  // same as a terminated field employee is excluded from its team card
  // -- and show up in Archived instead, consistent with how the rest
  // of this modal already treats termination. ----
  {
    const { sandbox, contentEl } = buildSandbox({ termData: { e2: { status: 'terminated' } } });
    await sandbox.renderTeamManager();
    const html = contentEl.innerHTML;
    check('the Admin/Office section does not render at all (Linda was its only member, and she\'s excluded)', /🏢 Admin \/ Office/.test(html), false);
    check('Linda shows up in Archived instead, same as any other terminated employee', /📁 Archived[\s\S]*Linda/.test(html), true);
  }

  // ---- Safety: a throwing _adminEmpDayOff degrades to an error card, never blanks the rest ----
  {
    const { sandbox, contentEl } = buildSandbox({
      adminDayOffFn: function () { throw new Error('synthetic admin-section failure'); },
    });
    await sandbox.renderTeamManager();
    const html = contentEl.innerHTML;
    check('team cards (B1) still rendered despite the Admin/Office section throwing', /B1/.test(html), true);
    check('the Unassigned section still rendered (Pat) despite the Admin/Office section throwing', /Pat/.test(html), true);
    check('an Admin/Office-specific error card is shown instead of silence', /Admin\/Office section failed to load/.test(html), true);
    check('the error card surfaces the real error message', /synthetic admin-section failure/.test(html), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
