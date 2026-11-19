// Stage 2a of 3: per-person permission toggles, the model + enforcement
// code (no migration needed -- manager_permissions is an existing jsonb
// column). This file drives the REAL _pentaCan/_pentaCanSeeTeam/preset
// payloads/Claire-tool-gating (extracted from index.html, run in a vm
// sandbox) with FAKE data only.
//
// Run with: node tests/stage2a-permissions.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function extract(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) { console.error('FAIL: could not find start marker: ' + startMarker); process.exit(1); }
  const e = src.indexOf(endMarker, s);
  if (e === -1) { console.error('FAIL: could not find end marker after ' + startMarker); process.exit(1); }
  return src.slice(s, e);
}

// Covers SCHEDULE_PERMISSION_DEFAULTS, PRESET_PERMISSIONS, PRESET_LABELS,
// _pentaCan, _pentaVisibleTeams, _pentaCanSeeTeam, _pentaFilterVisibleTeams,
// DEFAULT_PERMISSIONS, getPermissions, setPermission, isPermitted --
// all declared back-to-back in this order.
const permSrc = extract('// Stage 2: Schedule-screen + Claire permission keys', '\nfunction applyPermissions() {');

function buildSandbox(opts) {
  opts = opts || {};
  const sandbox = {
    console,
    localStorage: {
      _store: {},
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null; },
      setItem: function (k, v) { this._store[k] = v; }
    },
    getCurrentAppRole: function () { return opts.role === undefined ? 'manager' : opts.role; },
    getCachedManagerPermissions: function () { return opts.managerPerms || {}; }
  };
  vm.createContext(sandbox);
  vm.runInContext(permSrc, sandbox);
  return sandbox;
}

function main() {
  // ---- _pentaCan truth table ----
  {
    const sandbox = buildSandbox({ role: 'owner' });
    check('owner always passes any permission check, regardless of manager_permissions', sandbox._pentaCan('see_revenue_total'), true);
    check('owner always passes do_close_day too (the one opt-in key)', sandbox._pentaCan('do_close_day'), true);
  }
  {
    // Existing manager, nothing saved -- must behave EXACTLY as today.
    const sandbox = buildSandbox({ role: 'manager', managerPerms: {} });
    check('an existing manager with no saved permissions sees revenue (missing key = full access)', sandbox._pentaCan('see_revenue_total'), true);
    check('an existing manager with no saved permissions can add jobs', sandbox._pentaCan('do_add_job'), true);
    check('an existing manager with no saved permissions still has NO Close Day (the one opt-in default)', sandbox._pentaCan('do_close_day'), false);
    check('...nor the Close Day button itself', sandbox._pentaCan('see_close_day_button'), false);
  }
  {
    const sandbox = buildSandbox({ role: 'manager', managerPerms: { see_revenue_total: false, do_add_job: false } });
    check('an explicit false restriction is respected', sandbox._pentaCan('see_revenue_total'), false);
    check('a second explicit false restriction is respected independently', sandbox._pentaCan('do_add_job'), false);
    check('an unrelated key stays permissive', sandbox._pentaCan('do_edit_job'), true);
  }
  {
    const sandbox = buildSandbox({ role: 'manager', managerPerms: { see_close_day_button: true, do_close_day: true } });
    check('Close Day can be explicitly opted IN for one manager', sandbox._pentaCan('do_close_day'), true);
  }

  // ---- _pentaCanSeeTeam / _pentaVisibleTeams / _pentaFilterVisibleTeams ----
  {
    const sandbox = buildSandbox({ role: 'manager', managerPerms: {} });
    check('no teams_visible set -- every team is visible (today\'s behavior)', sandbox._pentaVisibleTeams(), null);
    check('_pentaCanSeeTeam is true for any team when nothing is restricted', sandbox._pentaCanSeeTeam('B3'), true);
  }
  {
    const sandbox = buildSandbox({ role: 'manager', managerPerms: { teams_visible: ['B3', 'S1'] } });
    check('a restricted team list only allows those teams', sandbox._pentaCanSeeTeam('B3'), true);
    check('a team not in the list is hidden', sandbox._pentaCanSeeTeam('M2'), false);
    const items = [{ id: 'j1', team: 'B3' }, { id: 'j2', team: 'M2' }, { id: 'j3', team: 'S1' }];
    check('_pentaFilterVisibleTeams drops exactly the hidden-team items', sandbox._pentaFilterVisibleTeams(items).map(function (i) { return i.id; }), ['j1', 'j3']);
  }
  {
    const sandbox = buildSandbox({ role: 'manager', managerPerms: { teams_visible: [] } });
    check('an empty teams_visible array hides every team (Limited manager preset default)', sandbox._pentaCanSeeTeam('B3'), false);
  }

  // ---- Preset payloads match the task's own spec ----
  {
    const sandbox = buildSandbox({});
    const limited = sandbox.PRESET_PERMISSIONS.limited_manager;
    check('Limited manager: no revenue total', limited.see_revenue_total, false);
    check('Limited manager: no day revenue', limited.see_day_revenue, false);
    check('Limited manager: no team revenue', limited.see_team_revenue, false);
    check('Limited manager: no job price', limited.see_job_price, false);
    check('Limited manager: no pay/payroll', limited.see_payroll, false);
    check('Limited manager: no Close Day', limited.do_close_day, false);
    check('Limited manager: no add job', limited.do_add_job, false);
    check('Limited manager: no edit job', limited.do_edit_job, false);
    check('Limited manager: no cancel job', limited.do_cancel_job, false);
    check('Limited manager: starts with an explicit (empty) team selection, not "all teams"', Array.isArray(limited.teams_visible), true);

    const office = sandbox.PRESET_PERMISSIONS.office_manager;
    check('Office manager: no revenue/pay/Close Day', office.see_revenue_total === false && office.see_payroll === false && office.do_close_day === false, true);
    check('Office manager: everything else untouched (add job still allowed)', Object.prototype.hasOwnProperty.call(office, 'do_add_job'), false);

    check('Full manager preset restricts nothing', JSON.stringify(sandbox.PRESET_PERMISSIONS.full_manager), '{}');
    check('"Owner (everything)" preset also restricts nothing (permissions only, never an actual role change)', JSON.stringify(sandbox.PRESET_PERMISSIONS.owner_everything), '{}');
  }

  // ---- getPermissions/isPermitted still work for the pre-existing
  // icon-visibility keys (Sarah's existing restrictions must keep
  // working inside the same permissions JSON). ----
  {
    const sandbox = buildSandbox({ role: 'manager', managerPerms: { payments_icon: false } });
    const perms = sandbox.getPermissions();
    check('a pre-existing icon-visibility restriction still merges in correctly', perms.manager.payments_icon, false);
    check('isPermitted still reflects it', sandbox.isPermitted('manager', 'payments_icon'), false);
    check('and a brand-new Stage 2 key coexists in the same object without conflict', perms.manager.see_revenue_total, true);
  }

  // ---- Claire tool permission map + guard logic (reimplemented here
  // identically to the real guard, since the real dispatcher is too
  // large to sandbox whole -- this proves the MAP and the short-circuit
  // logic, which is what Stage 0's audit flagged as the actual gap). ----
  {
    const mapSrc = extract('var CLAIRE_TOOL_PERMISSION_MAP = {', '\n};') + '\n};';
    const sandbox = buildSandbox({ role: 'manager', managerPerms: { see_revenue_total: false, do_add_job: false } });
    vm.runInContext(mapSrc, sandbox);
    function guard(name) {
      var required = sandbox.CLAIRE_TOOL_PERMISSION_MAP[name];
      if (required && !sandbox._pentaCan(required)) throw new Error("you don't have permission to do that.");
      return 'would-run';
    }
    let threw = null;
    try { guard('revenue_summary'); } catch (e) { threw = e.message; }
    check('a revenue-restricted manager gets denied by Claire\'s revenue_summary tool too', threw, "you don't have permission to do that.");
    threw = null;
    try { guard('get_revenue'); } catch (e) { threw = e.message; }
    check('...and get_revenue', threw, "you don't have permission to do that.");
    threw = null;
    try { guard('schedule_clean'); } catch (e) { threw = e.message; }
    check('...and schedule_clean (do_add_job restricted)', threw, "you don't have permission to do that.");
    let result = null;
    try { result = guard('move_clean'); } catch (e) { result = 'threw'; }
    check('an unrestricted tool (move_clean, do_move_job not restricted here) is NOT denied', result, 'would-run');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
