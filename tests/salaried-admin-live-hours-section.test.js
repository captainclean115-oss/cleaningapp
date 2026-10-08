// Salaried Admin/Office (follow-up to migration 113) -- Live Hours
// tab's Admin/Office group (renderHoursTable).
//
// Extracts the REAL Admin/Office block (not the whole renderHoursTable
// function, which needs the full team-card/GPS machinery this test
// isn't about) and wraps it in a thin synthetic harness that supplies
// exactly the locals it closes over (days, dayNames, today, expanded,
// html) -- same statements, same branching, just callable in
// isolation.
//
// Run with: node tests/salaried-admin-live-hours-section.test.js

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

const blockSrc = extract(
  '  try {\n    const adminEmployees = getUnifiedRoster().filter(e => e.work_type === \'admin\');',
  '\n\n  // All Teams summary',
  'renderHoursTable Admin/Office block'
);

const harnessSrc = `
function runAdminGroup(days, dayNames, today, expanded) {
  var html = '';
${blockSrc}
  return html;
}
`;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d) => new Date(d + 'T00:00:00'));
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function buildSandbox(opts) {
  opts = opts || {};
  const roster = opts.roster || [];
  const overrides = opts.overrides || {};
  const offDays = opts.offDays || {};
  const sandbox = {
    console,
    getUnifiedRoster: () => roster,
    isSalariedAdmin: (emp) => emp && emp.work_type === 'admin' && emp.pay_type === 'salary',
    _adminEmpDayOff: (empId, dk) => offDays[empId + '|' + dk] || null,
    getEmpHours: (empId, dk) => (overrides[empId] && overrides[empId][dk]) || null,
    dateKey: (d) => d.toISOString().slice(0, 10),
    _audEsc: (s) => String(s == null ? '' : s),
    _hrsFmtHrs: (h) => (!h || h <= 0 ? '0' : h.toFixed(1).replace(/\.0$/, '')),
    _hrsFmt12: (s) => s,
  };
  vm.createContext(sandbox);
  vm.runInContext(harnessSrc, sandbox);
  return sandbox;
}

function main() {
  // ---- Salaried admin: no day cells, no onclick, no hours, labeled "Salaried" ----
  {
    const roster = [{ id: 'e-linda', name: 'Linda', work_type: 'admin', pay_type: 'salary' }];
    const sandbox = buildSandbox({ roster });
    const html = sandbox.runAdminGroup(DAYS, DAY_NAMES, new Date('2026-10-08T00:00:00'), {});

    check('the Salaried label shows for Linda', /Salaried — no hours tracked/.test(html), true);
    check('no day-cell grid is rendered for her at all (class="hrs-days")', /hrs-days"/.test(html), false);
    check('no tap-to-edit onclick is wired for her (showEmpDayDetail)', /showEmpDayDetail/.test(html), false);
    check('no hour figures rendered for her (no "h this week" sub-label)', /this week/.test(html), false);
    check('the team-level total for the Admin/Office card is 0 (she contributes nothing)', /hrs-team-total">0</.test(html), true);
  }

  // ---- Hourly admin (not salaried): unaffected, still gets the full day-cell grid ----
  {
    const roster = [{ id: 'e-pat', name: 'Pat', work_type: 'admin', pay_type: 'hourly' }];
    const overrides = { 'e-pat': { '2026-10-06': { start: '09:00', end: '17:00', lunch: 30, hours: 7.5 } } };
    const sandbox = buildSandbox({ roster, overrides });
    const html = sandbox.runAdminGroup(DAYS, DAY_NAMES, new Date('2026-10-08T00:00:00'), {});

    check('Pat (hourly admin) still gets the day-cell grid', /hrs-days"/.test(html), true);
    check('Pat\'s real override hours show', /7.5/.test(html), true);
    check('Pat is NOT labeled Salaried', /Salaried/.test(html), false);
    check('the team total reflects Pat\'s real 7.5h', /hrs-team-total">7.5</.test(html), true);
  }

  // ---- Mixed roster: salaried contributes 0, hourly contributes its real hours, to the SAME total ----
  {
    const roster = [
      { id: 'e-linda', name: 'Linda', work_type: 'admin', pay_type: 'salary' },
      { id: 'e-pat', name: 'Pat', work_type: 'admin', pay_type: 'hourly' },
    ];
    const overrides = { 'e-pat': { '2026-10-06': { start: '09:00', end: '14:00', lunch: 0, hours: 5 } } };
    const sandbox = buildSandbox({ roster, overrides });
    const html = sandbox.runAdminGroup(DAYS, DAY_NAMES, new Date('2026-10-08T00:00:00'), {});

    check('the Admin/Office card total is exactly Pat\'s 5h -- Linda added nothing', /hrs-team-total">5</.test(html), true);
    check('both employees are listed', /Linda/.test(html) && /Pat/.test(html), true);
  }

  // ---- A throwing getEmpHours for one admin row degrades to an error card, doesn't blank the section ----
  {
    const roster = [{ id: 'e-pat', name: 'Pat', work_type: 'admin', pay_type: 'hourly' }];
    const sandbox = buildSandbox({ roster });
    sandbox.getEmpHours = () => { throw new Error('synthetic failure'); };
    const html = sandbox.runAdminGroup(DAYS, DAY_NAMES, new Date('2026-10-08T00:00:00'), {});
    check('a thrown error degrades to a visible error card', /Admin\/Office hours failed to load/.test(html), true);
    check('the real error message is surfaced', /synthetic failure/.test(html), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
