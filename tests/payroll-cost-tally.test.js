// Payroll cost tally feature -- unit tests for _computeDayPayCents() and
// _computeWeekPayroll(), extracting and running the ACTUAL functions
// from index.html. resolveEmployeeDayHours is stubbed per-scenario here
// (its own arithmetic is proven in resolve-employee-day-hours-
// equivalence.test.js) -- this file's job is the PAYROLL math layered
// on top: cents-based rounding, overtime split, missing-rate exclusion,
// salaried exclusion, terminated-employee date-awareness, and that the
// tally's total hours match what the Hours table itself would show for
// the same fixture.
//
// Run with: node tests/payroll-cost-tally.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(INDEX_HTML, 'utf8');

function extract(startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error('extraction failed: could not find start marker (' + label + '): ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('extraction failed: could not find end marker after start (' + label + '): ' + endMarker);
  return src.slice(s, e);
}

const payrollSrc = extract(
  'function _computeDayPayCents(hoursToday, rate, cumHoursBeforeToday, overtimeEnabled) {',
  '\nasync function publishWeekHours(',
  '_computeDayPayCents + _employerTaxPct + _getPayrollSettings + _computeWeekPayroll'
);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function dk(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function buildSandbox() {
  const sandbox = {
    console: console,
    dateKey: dk,
    isSalariedAdmin: function (emp) { return emp.work_type === 'admin' && emp.pay_type === 'salary'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(payrollSrc, sandbox);
  return sandbox;
}

(function () {
  console.log('Testing extracted _computeDayPayCents() from index.html\n');

  const sandbox = buildSandbox();
  const cdpc = sandbox._computeDayPayCents;

  check('8h at $20/hr, no overtime setting: 1600 cents ($16.00... wait, 8*20=160 -> 16000 cents)', cdpc(8, 20, 0, false), 16000);
  check('overtime OFF: a day that would cross 40 cumulative still pays straight time', cdpc(13, 20, 32, false), 26000);
  check('overtime ON, day entirely within the first 40h: straight time only', cdpc(8, 20, 0, true), 16000);
  check('overtime ON, day entirely AFTER 40h already accumulated: all 1.5x', cdpc(5, 20, 40, true), 15000);
  check('overtime ON, day SPLITS across the 40h line (32 before + 13 today -> 8 straight + 5 OT)', cdpc(13, 20, 32, true), (8 * 20 + 5 * 20 * 1.5) * 100);
  check('fractional hours round to the nearest cent, once, at the end', cdpc(1 / 3, 18, 0, false), Math.round((1 / 3) * 18 * 100));

  console.log('\nTesting extracted _computeWeekPayroll() from index.html\n');

  const ELVIA_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const LINDA_UUID = 'aaaaaaaa-0000-4000-8000-000000000002';
  const PAT_UUID = 'aaaaaaaa-0000-4000-8000-000000000003';
  const ROSA_UUID = 'aaaaaaaa-0000-4000-8000-000000000004';
  const NORATE_UUID = 'aaaaaaaa-0000-4000-8000-000000000005';

  const ROSTER = [
    { id: 'elvia-legacy', uuid: ELVIA_UUID, name: 'Elvia', work_type: 'field', status: 'active', pay_rate: 20 },
    { id: 'linda-legacy', uuid: LINDA_UUID, name: 'Linda', work_type: 'admin', pay_type: 'hourly', status: 'active', pay_rate: 15 },
    { id: 'pat-legacy', uuid: PAT_UUID, name: 'Pat', work_type: 'admin', pay_type: 'salary', status: 'active', pay_rate: null },
    { id: 'rosa-legacy', uuid: ROSA_UUID, name: 'Rosa', work_type: 'field', status: 'terminated', terminated_at: '2026-08-19', pay_rate: 18 },
    { id: 'norate-legacy', uuid: NORATE_UUID, name: 'NoRate', work_type: 'field', status: 'active', pay_rate: null },
  ];

  // Elvia: 8h Mon-Thu, 13h Fri -- 45h total, crosses 40 on Friday.
  const ELVIA_RD = {
    '2026-08-17': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
    '2026-08-18': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
    '2026-08-19': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
    '2026-08-20': { dayTeam: 'B1', isOff: false, hours: 8, isOverride: false },
    '2026-08-21': { dayTeam: 'B1', isOff: false, hours: 13, isOverride: false },
  };
  // Rosa: worked Mon/Tue only (terminated effective Wed 2026-08-19).
  const ROSA_RD = {
    '2026-08-17': { dayTeam: 'B2', isOff: false, hours: 8, isOverride: false },
    '2026-08-18': { dayTeam: 'B2', isOff: false, hours: 8, isOverride: false },
  };
  // NoRate: worked normally, but has no pay_rate on file.
  const NORATE_RD = {
    '2026-08-17': { dayTeam: 'B3', isOff: false, hours: 8, isOverride: false },
  };

  function makeSandboxForWeek(overtimeEnabled) {
    const sandbox2 = {
      console: console,
      dateKey: dk,
      isSalariedAdmin: function (emp) { return emp.work_type === 'admin' && emp.pay_type === 'salary'; },
      getUnifiedRoster: function (asOfDate) {
        return ROSTER.filter(function (e) {
          if (e.status !== 'terminated') return true;
          return !(e.terminated_at && asOfDate >= e.terminated_at);
        });
      },
      _adminEmpDayOff: function () { return null; },
      getEmpHours: function (empId, dateStr) {
        if (empId === 'linda-legacy' && dateStr === '2026-08-17') return { hours: 6, start: '09:00', end: '15:00', lunch: 0 };
        return null;
      },
      resolveEmployeeDayHours: function (empId, d, dayIdx) {
        const dateStr = dk(d);
        if (empId === 'elvia-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ELVIA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        if (empId === 'rosa-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ROSA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        if (empId === 'norate-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, NORATE_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        return { dayTeam: null, isOff: true, hours: 0, isOverride: false, startDate: null, endDate: null, lunchMin: 0 };
      },
    };
    vm.createContext(sandbox2);
    vm.runInContext(payrollSrc, sandbox2);
    return sandbox2;
  }

  const days = [17, 18, 19, 20, 21].map(function (day) { return new Date(2026, 7, day); });

  // Freeze "now" inside the sandbox so every fixture day counts as
  // already happened (the real function skips any day > now).
  function withFrozenNow(sandbox2, fn) {
    const realDate = Date;
    const frozen = new realDate(2026, 7, 22);
    sandbox2.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) return new realDate(frozen); return new realDate(...args); }
      static now() { return frozen.getTime(); }
    };
    return fn();
  }

  // ---- Overtime OFF ----
  {
    const sandbox2 = makeSandboxForWeek(false);
    const result = withFrozenNow(sandbox2, function () {
      return sandbox2._computeWeekPayroll(days, {}, {}, { overtime_enabled: false });
    });
    const elvia = result.included.find(function (e) { return e.empId === ELVIA_UUID; });
    const linda = result.included.find(function (e) { return e.empId === LINDA_UUID; });
    const pat = result.salaried.find(function (e) { return e.empId === PAT_UUID; });
    const rosa = result.included.find(function (e) { return e.empId === ROSA_UUID; });
    const norate = result.missingRate.find(function (e) { return e.empId === NORATE_UUID; });

    check('overtime OFF: Elvia 45h total', elvia.hours, 45);
    check('overtime OFF: Elvia gross is straight 45*$20, no 1.5x', elvia.grossCents, 45 * 20 * 100);
    check('Linda (hourly admin): 6h from her manual override', linda.hours, 6);
    check('Linda gross: 6 * $15', linda.grossCents, 6 * 15 * 100);
    check('Pat (salaried) is listed separately, not in included', !!pat, true);
    check('Pat contributes nothing to totals', result.totalHours, result.included.reduce(function (s, e) { return s + e.hours; }, 0));
    check('Rosa (terminated Wed): only Mon+Tue counted, 16h', rosa.hours, 16);
    check('Rosa gross: 16 * $18', rosa.grossCents, 16 * 18 * 100);
    check('NoRate employee is listed under missing-rate, not included', !!norate, true);
    check('NoRate contributes zero to the gross total', result.perEmployee.some(function (e) { return e.empId === NORATE_UUID && e.status === 'included'; }), false);

    const expectedTotalHours = elvia.hours + linda.hours + rosa.hours;
    check('total hours = sum of every INCLUDED employee (missing-rate/salaried excluded)', result.totalHours, expectedTotalHours);
    const expectedTotalCents = elvia.grossCents + linda.grossCents + rosa.grossCents;
    check('total gross cents = sum of every included employee\'s gross', result.totalGrossCents, expectedTotalCents);
  }

  // ---- Overtime ON ----
  {
    const sandbox2 = makeSandboxForWeek(true);
    const result = withFrozenNow(sandbox2, function () {
      return sandbox2._computeWeekPayroll(days, {}, {}, { overtime_enabled: true });
    });
    const elvia = result.included.find(function (e) { return e.empId === ELVIA_UUID; });
    check('overtime ON: Elvia total hours unchanged (45h -- OT affects pay, not hours)', elvia.hours, 45);
    check('overtime ON: Elvia gross reflects 40 straight + 5 at 1.5x', elvia.grossCents, Math.round(40 * 20 * 100 + 5 * 20 * 1.5 * 100));
    check('overtime ON: Elvia gross is HIGHER than with overtime off', elvia.grossCents > 45 * 20 * 100, true);
  }

  // ---- Consistency: total hours matches what the Hours table itself
  // would show for the same fixture (same resolveEmployeeDayHours calls,
  // same roster -- this is the actual guarantee, not a coincidence). ----
  {
    const sandbox2 = makeSandboxForWeek(false);
    const result = withFrozenNow(sandbox2, function () {
      return sandbox2._computeWeekPayroll(days, {}, {}, { overtime_enabled: false });
    });
    let manualTotal = 0;
    ['elvia-legacy', 'rosa-legacy'].forEach(function (empId) {
      days.forEach(function (d, i) {
        var rd = sandbox2.resolveEmployeeDayHours(empId, d, i);
        var dk2 = dk(d);
        var inRoster = sandbox2.getUnifiedRoster(dk2).some(function (e) { return e.id === empId; });
        if (inRoster && !rd.isOff) manualTotal += rd.hours;
      });
    });
    manualTotal += 6; // Linda's override
    check('payroll tally\'s total hours equal hand-summed resolveEmployeeDayHours totals for the same fixture', result.totalHours, manualTotal);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
