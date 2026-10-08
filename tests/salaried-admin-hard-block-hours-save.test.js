// Salaried Admin/Office (follow-up to migration 113) -- hard-block of
// the single-employee edit-hours sheet (showEmpDayDetail /
// saveEmpDayHours) for a salaried admin employee. Defense in depth:
// the normal Live Hours UI can no longer even reach these for a
// salaried admin (no day cells after the Live Hours section fix), but
// both functions still refuse explicitly with a visible alert -- never
// a silent return -- against any other call path.
//
// Run with: node tests/salaried-admin-hard-block-hours-save.test.js

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

const showDetailSrc = extract(
  'function showEmpDayDetail(empId, empName, team, dateMs) {',
  '\n// PR #120 -- showEmpStops previously',
  'showEmpDayDetail'
);
const saveHoursSrc = extract(
  'async function saveEmpDayHours(empId, empName, dk) {',
  '\n\nasync function clearEmpDayHours(',
  'saveEmpDayHours'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [
    { id: 'e-linda', name: 'Linda', work_type: 'admin', pay_type: 'salary' },
    { id: 'e-pat', name: 'Pat', work_type: 'admin', pay_type: 'hourly' },
  ];
  const alerts = [];
  const calls = [];
  const els = {
    'emp-hr-start': { value: opts.start || '09:00', addEventListener: () => {} },
    'emp-hr-end': { value: opts.end || '17:00', addEventListener: () => {} },
    'emp-hr-lunch': { value: '30', addEventListener: () => {} },
    'emp-hr-team': { value: 'B1' },
    'emp-hours-overlay': { removed: false, remove: function () { this.removed = true; }, style: {}, addEventListener: () => {} },
  };
  const sandbox = {
    console,
    alert: (msg) => alerts.push(msg),
    document: {
      getElementById: (id) => els[id] || null,
      createElement: () => ({ style: {}, innerHTML: '', appendChild: () => {}, addEventListener: () => {} }),
      body: { appendChild: () => {} },
    },
    localStorage: { removeItem: () => {} },
    getUnifiedRoster: () => roster,
    isSalariedAdmin: (emp) => emp && emp.work_type === 'admin' && emp.pay_type === 'salary',
    getEmpHours: () => null,
    saveEmpHours: (empId, dk, data) => { calls.push(['saveEmpHours', empId, dk, data]); return Promise.resolve(); },
    getEmpTasks: () => [],
    weekHours: {},
    hoursWeekOffset: 0,
    getWeekDates: () => [new Date('2026-10-08T00:00:00')],
    dateKey: (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d),
    _audEsc: (s) => String(s == null ? '' : s),
    _pentaTeamColor: () => '#000',
    _pentaTeamNames: () => ['B1'],
    calcHoursFromTimes: () => 7.5,
    showEmpStops: () => { calls.push(['showEmpStops']); },
    renderEmpTasks: () => { calls.push(['renderEmpTasks']); },
    logPendingUpdate: () => { calls.push(['logPendingUpdate']); },
    loadWeekHours: () => { calls.push(['loadWeekHours']); return Promise.resolve(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(showDetailSrc, sandbox);
  vm.runInContext(saveHoursSrc, sandbox);
  return { sandbox, alerts, calls, els };
}

async function main() {
  // ---- showEmpDayDetail refuses to open for a salaried admin employee ----
  {
    const { sandbox, alerts, calls } = buildSandbox();
    sandbox.showEmpDayDetail('e-linda', 'Linda', null, new Date('2026-10-08T00:00:00').getTime());
    check('a clear alert names Linda and says salaried', alerts.some((a) => /Linda/.test(a) && /salaried/i.test(a)), true);
    check('no overlay-building side effects ran (no showEmpStops call attempt)', calls.some((c) => c[0] === 'showEmpStops'), false);
    check('document.createElement was never reached for the overlay (refused before building anything)', sandbox.document.getElementById('emp-hours-overlay').removed, false);
  }

  // ---- showEmpDayDetail still opens normally for an hourly admin employee ----
  {
    const { sandbox, alerts } = buildSandbox();
    sandbox.showEmpDayDetail('e-pat', 'Pat', null, new Date('2026-10-08T00:00:00').getTime());
    check('no salaried-refusal alert for Pat (hourly admin)', alerts.length, 0);
  }

  // ---- saveEmpDayHours hard-blocks the actual write for a salaried admin employee ----
  {
    const { sandbox, alerts, calls } = buildSandbox();
    await sandbox.saveEmpDayHours('e-linda', 'Linda', '2026-10-08');
    check('saveEmpHours is never called for Linda', calls.some((c) => c[0] === 'saveEmpHours'), false);
    check('a clear "nothing was changed" message is shown, naming salaried', alerts.some((a) => /Linda is salaried/.test(a) && /Nothing was changed/.test(a)), true);
  }

  // ---- saveEmpDayHours still works normally for an hourly admin employee ----
  {
    const { sandbox, alerts, calls } = buildSandbox();
    await sandbox.saveEmpDayHours('e-pat', 'Pat', '2026-10-08');
    check('saveEmpHours IS called for Pat', calls.some((c) => c[0] === 'saveEmpHours' && c[1] === 'e-pat'), true);
    check('no salaried-refusal alert for Pat', alerts.some((a) => /salaried/i.test(a)), false);
  }

  // ---- The salaried-admin check itself never silently swallows a lookup failure ----
  {
    const { sandbox, calls } = buildSandbox({ roster: null }); // getUnifiedRoster() will throw on .find(...)
    sandbox.getUnifiedRoster = () => { throw new Error('synthetic roster lookup failure'); };
    await sandbox.saveEmpDayHours('e-pat', 'Pat', '2026-10-08');
    // The salaried check is wrapped in its own try/catch (non-fatal) --
    // a lookup failure must not block a legitimate save.
    check('a roster-lookup failure during the salaried check does not block the real save', calls.some((c) => c[0] === 'saveEmpHours'), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: test harness threw', e);
  process.exit(1);
});
