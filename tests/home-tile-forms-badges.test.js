// Tom: "there should be a notifications circle thing on the staff icon so
// manager knows when things come in." Investigation found TWO gaps, both
// fixed here:
//
// 1. The 'staff' home-grid tile had no badge at all -- a new employee
//    form submission (time off, call-out, etc.) was invisible from the
//    home screen unless Tom already knew to open a specific employee's
//    modal. Added a `badge` counting pending PentaForms, matching the
//    existing pattern already used by 'messages'/'payments'/'content'
//    tiles.
// 2. The EXISTING 'tasks' ("Updates") home-grid tile's badge -- which
//    Tom likely WAS watching, since "Updates" is the natural place for
//    this -- never included forms at all: it only counted
//    cleanco_pending + cleanco_tasks from localStorage. Meanwhile the
//    bottom-nav "Updates" label (updateTaskBadge(), index.html ~17302)
//    DOES include a pending-forms count -- two independent copies of the
//    same "how many things need my attention" computation had drifted
//    apart (mirrored-algorithm-diverge class of bug). A submitted form
//    never lit up the home-screen tile even though the more detailed
//    nav-label badge would eventually reflect it. Fixed to mirror
//    updateTaskBadge()'s count exactly.
//
// Both extracted from the real HOME_APPS array (not reimplemented) so a
// future edit to either tile's badge logic is caught here.
//
// Run with: node tests/home-tile-forms-badges.test.js

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

const startMarker = 'var HOME_APPS = [';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('FAIL: could not find HOME_APPS array'); process.exit(1); }
const endIdx = src.indexOf('\n];', startIdx);
if (endIdx === -1) { console.error('FAIL: could not find HOME_APPS end boundary'); process.exit(1); }
const homeAppsSrc = src.slice(startIdx, endIdx + '\n];'.length);

function buildSandbox(pendingForms, localStorageData) {
  const store = Object.assign({ cleanco_pending: '[]', cleanco_tasks: '[]' }, localStorageData || {});
  const sandbox = {
    console,
    LUCIDE: new Proxy({}, { get: function() { return '<svg></svg>'; } }),
    localStorage: {
      getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    },
    window: {
      PentaForms: { listSync: function() { return pendingForms; } },
    },
    // Referenced by other tiles' go()/badge() in the array -- not under
    // test here, just needs to exist so the array literal evaluates.
    PentaClients: { filterClients: function() { return []; } },
    showTab: function() {}, openQuoteTool: function() {}, openContentView: function() {},
    _launcherComingSoon: function() {}, openChurnDemo: function() {}, openFiles: function() {},
    showClientsSubview: function() {}, showStaffView: function() {}, openRouteOptimizer: function() {},
    openPaymentsDemo: function() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(homeAppsSrc, sandbox);
  return sandbox.HOME_APPS;
}

const PENDING_FORM = { id: 'f1', status: 'pending', employee_id: 'emp-1' };
const APPROVED_FORM = { id: 'f2', status: 'approved', employee_id: 'emp-1' };

// --- 'staff' tile: new badge counting pending forms business-wide ---
{
  const tiles = buildSandbox([PENDING_FORM, APPROVED_FORM]);
  const staffTile = tiles.find(function(t) { return t.id === 'staff'; });
  check('staff tile now has a badge function (previously none existed)', typeof staffTile.badge, 'function');
  check('staff tile badge counts only pending forms, business-wide', staffTile.badge(), 1);
}
{
  const tiles = buildSandbox([APPROVED_FORM]);
  const staffTile = tiles.find(function(t) { return t.id === 'staff'; });
  check('staff tile badge is 0 when nothing is pending', staffTile.badge(), 0);
}
{
  // PentaForms not yet hydrated / unavailable -- must not throw.
  const sandbox = buildSandbox([]);
  const tiles = buildSandbox([]);
  const staffTile = tiles.find(function(t) { return t.id === 'staff'; });
  check('staff tile badge is 0 (not a throw) with an empty forms cache', staffTile.badge(), 0);
}

// --- 'tasks' (Updates) tile: badge now includes forms, matching updateTaskBadge() ---
{
  const tiles = buildSandbox([PENDING_FORM], {
    cleanco_pending: JSON.stringify([{ done: false }, { done: true }]),
    cleanco_tasks: JSON.stringify([{ done: false }]),
  });
  const tasksTile = tiles.find(function(t) { return t.id === 'tasks'; });
  check(
    'Updates tile badge = pending-updates(1) + manual-tasks(1) + pending-forms(1) = 3, no longer forms-blind',
    tasksTile.badge(),
    3
  );
}
{
  const tiles = buildSandbox([], { cleanco_pending: '[]', cleanco_tasks: '[]' });
  const tasksTile = tiles.find(function(t) { return t.id === 'tasks'; });
  check('Updates tile badge is 0 when nothing is pending anywhere', tasksTile.badge(), 0);
}
{
  // Corrupt localStorage must not crash the whole home-screen render.
  const sandbox = {
    console,
    LUCIDE: new Proxy({}, { get: function() { return '<svg></svg>'; } }),
    localStorage: { getItem: function(k) { return k === 'cleanco_pending' ? 'not json' : '[]'; } },
    window: { PentaForms: { listSync: function() { return [PENDING_FORM]; } } },
    PentaClients: { filterClients: function() { return []; } },
    showTab: function() {}, openQuoteTool: function() {}, openContentView: function() {},
    _launcherComingSoon: function() {}, openChurnDemo: function() {}, openFiles: function() {},
    showClientsSubview: function() {}, showStaffView: function() {}, openRouteOptimizer: function() {},
    openPaymentsDemo: function() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(homeAppsSrc, sandbox);
  const tasksTile = sandbox.HOME_APPS.find(function(t) { return t.id === 'tasks'; });
  check('Updates tile badge degrades to 0 (not a throw) on corrupt localStorage', tasksTile.badge(), 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
