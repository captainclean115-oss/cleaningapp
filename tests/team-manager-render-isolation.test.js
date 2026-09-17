// Bug report: "Teams modal opens but no employees shown - blank list."
// Tom's hypothesis was a regression from PR #181 (saveDailyAssignments
// hardening) or a repeat of the PR #178 PentaEmployees hydrate race.
//
// Both ruled out by code review: PR #181's diff only touches write-side
// localStorage.setItem calls unrelated to renderTeamManager/getUnifiedRoster/
// openTeamManager, and PentaEmployees/PentaAssignments's hydrate-reset races
// (and PentaForms/PentaJobs/PentaRewards, checked while in there) all
// correctly reset _hydrating only after a real `await`, matching the PR #178
// fix -- none of them regressed, and renderTeamManager doesn't even consult
// PentaForms/PentaJobs/PentaRewards.
//
// Real cause, found by reading renderTeamManager itself: it builds one
// `html` string in memory and only assigns it to #team-mgr-content on its
// very last line. Two spots in that synchronous build were unguarded:
// (1) getRosterTermData()'s raw JSON.parse (called before any team card is
// built -- a throw here aborted the whole render before line one of output
// existed), and (2) the per-team `teams.forEach` loop, which calls
// _teamDayStats -- itself mostly unguarded (client/job field access) -- so
// a throw for any ONE team aborted the entire loop. Since openTeamManager
// shows the modal overlay BEFORE ever calling renderTeamManager (fire-and-
// forget, no await, no .catch()), an aborted render left an already-open
// modal with a permanently blank panel -- no banner, no toast, just a
// console error. Same silent-failure shape as PR #146's terminate-button bug.
//
// Fixed by (1) hardening getRosterTermData() to return {} non-fatally on a
// parse failure, and (2) isolating the per-team loop (and the
// unassigned/archived section after it) in their own try/catch, so one bad
// team degrades to a visible error card instead of blanking every other
// team too.
//
// Run with: node tests/team-manager-render-isolation.test.js

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

// ---- Extract getRosterTermData ----
const grtdStart = 'function getRosterTermData() {';
const grtdStartIdx = src.indexOf(grtdStart);
if (grtdStartIdx === -1) { console.error('FAIL: could not find getRosterTermData'); process.exit(1); }
const grtdEndIdx = src.indexOf('\nfunction saveRosterTermData', grtdStartIdx);
if (grtdEndIdx === -1) { console.error('FAIL: could not find end boundary after getRosterTermData'); process.exit(1); }
const grtdSource = src.slice(grtdStartIdx, grtdEndIdx);

if (!/function getRosterTermData\(\) \{\s*(?:\/\/[^\n]*\n\s*)*try \{/.test(grtdSource)) {
  console.error('FAIL: getRosterTermData does not appear to wrap its JSON.parse in try/catch -- fix may have been reverted.');
  process.exit(1);
}

// ---- Extract the per-team forEach block from renderTeamManager ----
const feStart = '  teams.forEach(team => {';
const feStartIdx = src.indexOf(feStart);
if (feStartIdx === -1) { console.error('FAIL: could not find the teams.forEach block'); process.exit(1); }
const feEndMarker = "  });\n\n  // Floaters / unassigned / archived";
const feEndIdx = src.indexOf(feEndMarker, feStartIdx);
if (feEndIdx === -1) { console.error('FAIL: could not find end boundary after the teams.forEach block'); process.exit(1); }
const feSource = src.slice(feStartIdx, feEndIdx) + '  });';

if (!/teams\.forEach\(team => \{[\s\S]*?try \{/.test(feSource)) {
  console.error('FAIL: the per-team loop does not appear to wrap its body in try/catch -- fix may have been reverted.');
  process.exit(1);
}

// ---- Extract the unassigned/archived try/catch block ----
const uaStartMarker = '// Floaters / unassigned / archived -- wrapped the same way as the';
const uaStartIdx = src.indexOf(uaStartMarker);
if (uaStartIdx === -1) { console.error('FAIL: could not find the unassigned/archived try block'); process.exit(1); }
const uaEndMarker = "  document.getElementById('team-mgr-content').innerHTML = html;";
const uaEndIdx = src.indexOf(uaEndMarker, uaStartIdx);
if (uaEndIdx === -1) { console.error('FAIL: could not find end boundary after the unassigned/archived block'); process.exit(1); }
const uaSource = src.slice(uaStartIdx, uaEndIdx);

function buildSandbox(overrides) {
  const sandbox = Object.assign({
    dateStr: '2026-09-17',
    teams: ['B1', 'S1'],
    html: '',
    _gpsDevices: [],
    _teamDeviceMap: {},
    dailyAssignments: {},
    DAY_OFF_CATEGORY_LABELS: { vacation: 'Vacation' },
    isActiveEmp: function() { return true; },
    _pentaTeamColor: function() { return '#6b7280'; },
    _adminEsc: function(s) { return String(s); },
    getUnifiedRoster: function() {
      return [
        { id: 'e1', name: 'Alice', role: [], team: 'B1' },
        { id: 'e2', name: 'Bob', role: [], team: 'S1' }
      ];
    },
    getEmployeeTeam: function(id) { return id === 'e1' ? 'B1' : id === 'e2' ? 'S1' : null; },
    getEmployeeDayOffInfo: function() { return null; },
    setTeamDeviceAssignment: function() {},
    openTeamColorEditor: function() {},
    openDayOffPicker: function() {},
    editEmployeeAssignment: function() {},
    openRosterEmpEdit: function() {},
    quickAssign: function() {},
    promptDefaultTeam: function() {},
    console: { error: function() {}, warn: function() {}, log: function() {} }
  }, overrides || {});
  vm.createContext(sandbox);
  return sandbox;
}

// Scenario 1: getRosterTermData never throws, even on corrupted JSON.
{
  const store = { roster_term_data: '{not valid json' };
  const sandbox = buildSandbox({
    localStorage: { getItem: function(k) { return store[k] || null; } }
  });
  vm.runInContext(grtdSource, sandbox);
  let threw = false, result;
  try { result = sandbox.getRosterTermData(); } catch (e) { threw = true; }
  check('getRosterTermData does not throw on corrupted JSON', threw, false);
  check('getRosterTermData falls back to {} on corrupted JSON', result, {});
}

// Scenario 2: one team's _teamDayStats throws -- the OTHER team must still
// render fully, and the failing team gets a visible error card, not a
// blanked-out modal.
{
  const sandbox = buildSandbox({
    _teamDayStats: function(team) {
      if (team === 'B1') throw new Error('client lookup exploded (simulated)');
      return { houses: 2, revenue: 300, mins: 240 };
    }
  });
  vm.runInContext(feSource, sandbox);
  check('the healthy team (S1) still renders its employee', sandbox.html.indexOf('Bob') !== -1, true);
  check('the healthy team (S1) still renders its team header', sandbox.html.indexOf('S1') !== -1, true);
  check('the failing team (B1) shows a visible error card instead of vanishing', sandbox.html.indexOf('B1 failed to load') !== -1, true);
  check('the failing team error message is surfaced', sandbox.html.indexOf('client lookup exploded') !== -1, true);
}

// Scenario 3: no team throws -- normal rendering is unaffected by the fix.
{
  const sandbox = buildSandbox({
    _teamDayStats: function() { return { houses: 1, revenue: 100, mins: 60 }; }
  });
  vm.runInContext(feSource, sandbox);
  check('both teams render normally when nothing throws', sandbox.html.indexOf('Alice') !== -1 && sandbox.html.indexOf('Bob') !== -1, true);
  check('no error cards appear when nothing throws', sandbox.html.indexOf('failed to load') !== -1, false);
}

// Scenario 4: the unassigned/archived section throws -- team cards already
// built (passed in via `html`) must survive, plus a visible error card.
{
  const sandbox = buildSandbox({
    html: '<div>PRE-EXISTING TEAM CARDS</div>',
    termData: {},
    getUnifiedRoster: function() { throw new Error('roster facade exploded (simulated)'); }
  });
  vm.runInContext(uaSource, sandbox);
  check('team cards built before this section survive a throw here', sandbox.html.indexOf('PRE-EXISTING TEAM CARDS') !== -1, true);
  check('a visible error card is appended instead of a silent abort', sandbox.html.indexOf('failed to load') !== -1, true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
