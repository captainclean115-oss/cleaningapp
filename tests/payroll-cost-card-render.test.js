// Payroll cost card bug fix -- RENDER-layer tests. Extracts the actual
// renderPayrollCostCard/_computeWeekPayroll/_computeDayPayCents/
// _employerTaxPct/_centsToDollarsStr/togglePayrollCardExpanded/
// setPayrollCardSort functions verbatim from index.html (same fixture
// shape as tests/payroll-cost-tally.test.js: a rated field employee, an
// unrated one, a salaried admin, an hourly admin, and a terminated
// employee) and drives the actual DOM string the card produces --
// proving the headline total matches the Hours table's own number, the
// visible mismatch warning fires when (and only when) they disagree,
// the breakdown lines are present and correctly worded, and the
// per-employee detail defaults to collapsed and never shows a missing-
// rate employee's hours next to a dollar amount.
//
// _getPayrollSettings is NOT extracted from index.html (it talks to a
// real Supabase client) -- a sandbox stub stands in for it, same
// discipline as every other network-touching function this test suite
// stubs elsewhere.
//
// Run with: node tests/payroll-cost-card-render.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed (' + label + '): could not find start marker: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed (' + label + '): could not find end marker after start: ' + endMarker);
  return src.slice(s, e);
}

const payrollMathSrc = extract(
  'function _computeDayPayCents(hoursToday, rate, cumHoursBeforeToday, overtimeEnabled) {',
  'var _payrollSettingsCache = null;',
  '_computeDayPayCents + _employerTaxPct'
);
const computeWeekPayrollSrc = extract(
  'function _computeWeekPayroll(days, weekHoursData, empHoursMapData, payrollSettings) {',
  'async function publishWeekHours(',
  '_computeWeekPayroll'
);
const cardSrc = extract(
  "var _payrollCardSort = 'name'; // 'name' | 'hours' | 'gross'",
  'function _updatePublishIndicator(',
  '_payrollCardSort/_payrollCardExpanded/_payrollCardLastArgs/_centsToDollarsStr/togglePayrollCardExpanded/setPayrollCardSort/renderPayrollCostCard'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

function dk(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ---- Fixture: same shape as payroll-cost-tally.test.js ----
const ELVIA_UUID = 'aaaaaaaa-1111-4000-8000-000000000001'; // field, rated, $20/hr
const LINDA_UUID = 'aaaaaaaa-1111-4000-8000-000000000002'; // admin, hourly -- out of this card's scope
const PAT_UUID = 'aaaaaaaa-1111-4000-8000-000000000003';   // admin, salaried -- named, no hours
const ROSA_UUID = 'aaaaaaaa-1111-4000-8000-000000000004';  // field, rated, terminated mid-week
const NORATE_UUID = 'aaaaaaaa-1111-4000-8000-000000000005'; // field, NO pay rate -- the bug's victim

const ROSTER = [
  { id: 'elvia-legacy', uuid: ELVIA_UUID, name: 'Elvia', work_type: 'field', status: 'active', pay_rate: 20 },
  { id: 'linda-legacy', uuid: LINDA_UUID, name: 'Linda', work_type: 'admin', pay_type: 'hourly', status: 'active', pay_rate: 15 },
  { id: 'pat-legacy', uuid: PAT_UUID, name: 'Pat', work_type: 'admin', pay_type: 'salary', status: 'active', pay_rate: null },
  { id: 'rosa-legacy', uuid: ROSA_UUID, name: 'Rosa', work_type: 'field', status: 'terminated', terminated_at: '2026-08-19', pay_rate: 18 },
  { id: 'norate-legacy', uuid: NORATE_UUID, name: 'NoRate', work_type: 'field', status: 'active', pay_rate: 0 }, // 0, not null -- the real-world shape
];

const ELVIA_RD = {
  '2026-08-17': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
  '2026-08-18': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
  '2026-08-19': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
  '2026-08-20': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
  '2026-08-21': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
};
const ROSA_RD = {
  '2026-08-17': { dayTeam: 'B2', isOff: false, hours: 8, isOverride: false },
  '2026-08-18': { dayTeam: 'B2', isOff: false, hours: 8, isOverride: false },
};
const NORATE_RD = {
  '2026-08-17': { dayTeam: 'B3', isOff: false, hours: 8, isOverride: false },
  '2026-08-18': { dayTeam: 'B3', isOff: false, hours: 8, isOverride: false },
};

function makeFakeDom() {
  const nodes = {};
  function el(id) {
    if (!nodes[id]) nodes[id] = { id, innerHTML: '' };
    return nodes[id];
  }
  return { nodes, getElementById: (id) => el(id) };
}

function buildSandbox(payrollSettings) {
  const fakeDom = makeFakeDom();
  const sandbox = {
    console,
    document: fakeDom,
    window: {},
    dateKey: dk,
    isSalariedAdmin: function (emp) { return emp.work_type === 'admin' && emp.pay_type === 'salary'; },
    getUnifiedRoster: function (asOfDate) {
      return ROSTER.filter(function (e) {
        if (e.status !== 'terminated') return true;
        return !(e.terminated_at && asOfDate >= e.terminated_at);
      });
    },
    resolveEmployeeDayHours: function (empId, d) {
      const dateStr = dk(d);
      if (empId === 'elvia-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ELVIA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
      if (empId === 'rosa-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ROSA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
      if (empId === 'norate-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, NORATE_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
      return { dayTeam: null, isOff: true, hours: 0, isOverride: false, startDate: null, endDate: null, lunchMin: 0 };
    },
    _getPayrollSettings: async function () { return payrollSettings; },
  };
  // window.* reads in the real code (window._hrsLastGrandTotal) --
  // alias so both `window.X` and the bare global resolve to the same
  // mutable slot inside this sandbox.
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(payrollMathSrc, sandbox);
  vm.runInContext(computeWeekPayrollSrc, sandbox);
  vm.runInContext(cardSrc, sandbox);
  return sandbox;
}

function withFrozenNow(sandbox, fn) {
  const realDate = Date;
  const frozen = new realDate(2026, 7, 22);
  sandbox.Date = class extends realDate {
    constructor(...args) { if (args.length === 0) return new realDate(frozen); return new realDate(...args); }
    static now() { return frozen.getTime(); }
  };
  return fn();
}

const days = [17, 18, 19, 20, 21].map((day) => new Date(2026, 7, day));

(async () => {
  console.log('--- Card total matches the Hours table total exactly (no mismatch warning) ---\n');
  {
    const sandbox = buildSandbox({ overtime_enabled: false, social_security_pct: 6.2, medicare_pct: 1.45, federal_unemployment_pct: 0.6, state_unemployment_pct: 2.7, other_employer_costs_pct: 0 });
    // The real "Hours table" total for this fixture: Elvia(40) + Rosa(16) + NoRate(16) = 72.
    sandbox._hrsLastGrandTotal = 72;
    await withFrozenNow(sandbox, () => sandbox.renderPayrollCostCard(days, {}, {}));
    const html = sandbox.document.getElementById('payroll-cost-card').innerHTML;

    checkTrue('card rendered something (not the error fallback)', html.indexOf('Payroll cost this week') !== -1);
    checkTrue('Total hours shows 72.00h (matches the Hours table exactly)', html.indexOf('72.00h') !== -1);
    check('NO mismatch warning when the numbers agree', html.indexOf('Hours total does not match the Hours table') !== -1, false);
    checkTrue('breakdown: "Hours with a pay rate" is present', html.indexOf('Hours with a pay rate:') !== -1);
    checkTrue('breakdown: Elvia+Rosa (56h) shown as the rated hours', html.indexOf('56.00h') !== -1);
    checkTrue('breakdown: "Hours with no pay rate" is present', html.indexOf('Hours with no pay rate:') !== -1);
    checkTrue('breakdown: NoRate\'s 16h shown as the unrated hours', html.indexOf('16.00h') !== -1);
    checkTrue('breakdown: exactly 1 employee with no pay rate', html.indexOf('(1 employee)') !== -1);
    checkTrue('Salaried line names Pat', html.indexOf('Salaried (not included in pay):') !== -1 && html.indexOf('Pat') !== -1);
    checkTrue('Hourly Admin/Office disclosure appears (Linda exists this week)', html.indexOf("Admin/Office hourly pay isn't included here yet") !== -1);
    checkTrue('the plain-English wages/taxes disclosure line is present', html.indexOf('Wages and taxes cover employees with a pay rate only.') !== -1);
    checkTrue('gross wages reflect ONLY Elvia+Rosa (rated field employees): 40*$20 + 16*$18 = $1088.00', html.indexOf('$1088.00') !== -1);
  }

  console.log('\n--- Gross wages/taxes computed only from rated employees (exact cents) ---\n');
  {
    const sandbox = buildSandbox({ overtime_enabled: false, social_security_pct: 6.2, medicare_pct: 1.45, federal_unemployment_pct: 0.6, state_unemployment_pct: 2.7, other_employer_costs_pct: 0 });
    const result = await withFrozenNow(sandbox, () => sandbox._computeWeekPayroll(days, {}, {}, { overtime_enabled: false }));
    const expectedGrossCents = 40 * 20 * 100 + 16 * 18 * 100; // Elvia + Rosa only
    check('totalGrossCents = Elvia(40h*$20) + Rosa(16h*$18), NoRate/Linda/Pat excluded', result.totalGrossCents, expectedGrossCents);
    check('totalHours = Elvia(40) + Rosa(16) + NoRate(16) -- NoRate\'s hours ARE counted', result.totalHours, 72);
  }

  console.log('\n--- Mismatch warning appears when forced ---\n');
  {
    const sandbox = buildSandbox({ overtime_enabled: false, social_security_pct: 6.2, medicare_pct: 1.45, federal_unemployment_pct: 0.6, state_unemployment_pct: 2.7, other_employer_costs_pct: 0 });
    sandbox._hrsLastGrandTotal = 999; // deliberately wrong -- the Hours table "said" something else
    await withFrozenNow(sandbox, () => sandbox.renderPayrollCostCard(days, {}, {}));
    const html = sandbox.document.getElementById('payroll-cost-card').innerHTML;
    checkTrue('mismatch warning appears in red when the two totals disagree', html.indexOf('Hours total does not match the Hours table') !== -1);
    checkTrue('warning is styled red (var(--red))', /color:var\(--red\)">Hours total does not match the Hours table/.test(html));
  }

  console.log('\n--- Per-employee breakdown defaults to collapsed; missing-rate employee never shown next to a dollar amount ---\n');
  {
    const sandbox = buildSandbox({ overtime_enabled: false, social_security_pct: 6.2, medicare_pct: 1.45, federal_unemployment_pct: 0.6, state_unemployment_pct: 2.7, other_employer_costs_pct: 0 });
    sandbox._hrsLastGrandTotal = 72;
    await withFrozenNow(sandbox, () => sandbox.renderPayrollCostCard(days, {}, {}));
    let html = sandbox.document.getElementById('payroll-cost-card').innerHTML;
    checkTrue('collapsed by default: button reads "Show per-employee breakdown"', html.indexOf('Show per-employee breakdown') !== -1);
    check('collapsed by default: the named per-employee Sort controls are NOT rendered', html.indexOf('Sort:') !== -1, false);

    sandbox.togglePayrollCardExpanded();
    // togglePayrollCardExpanded() fires the async renderPayrollCostCard
    // without awaiting it -- same as the real app's own call sites
    // (a button onclick can't await). Give its microtask/settle time to
    // actually finish before reading the DOM back out.
    await new Promise((r) => setTimeout(r, 10));
    html = sandbox.document.getElementById('payroll-cost-card').innerHTML;
    checkTrue('after expanding: button now reads "Hide details"', html.indexOf('Hide details') !== -1);
    checkTrue('after expanding: NoRate is named in the missing-rate sub-list', html.indexOf('NoRate') !== -1);
    const noRateLineMatch = html.match(/<div style="font-size:12px;color:var\(--red\)">NoRate[^<]*<\/div>/);
    checkTrue('NoRate\'s detail line exists', !!noRateLineMatch);
    check('NoRate\'s detail line never shows a dollar amount next to her (never a silent $0)', noRateLineMatch && noRateLineMatch[0].indexOf('$') !== -1, false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH:', e && e.stack || e); process.exit(1); });
