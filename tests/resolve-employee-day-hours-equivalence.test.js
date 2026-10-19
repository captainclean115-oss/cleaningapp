// Portal-hours-match-manager fix -- direct equivalence proof that
// extracting resolveEmployeeDayHours() out of renderHoursTable's inline
// per-day cell computation did not change the manager's own numbers in
// any way. The "OLD" formula below is copied VERBATIM from the pre-fix
// commit (git diff main -- index.html, the removed lines) -- not
// reconstructed from memory. For a wide battery of synthetic
// employee-day scenarios, this runs BOTH the old inline formula and the
// new extracted function against IDENTICAL inputs and asserts the
// outputs agree exactly. Also covers the specific fixtures requested:
// a manual override, a vehicle-swap day, a lunch deduction, and a shift
// that crosses midnight in UTC.
//
// Run with: node tests/resolve-employee-day-hours-equivalence.test.js

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

const newFnSrc = extract(
  'function resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData) {',
  '\n\nfunction renderHoursTable(days, dayNames) {',
  'resolveEmployeeDayHours (current)'
);

// Copied VERBATIM from the pre-fix commit's inline cell body (git diff
// main -- index.html shows these exact lines removed), wrapped as a
// standalone function with the same parameter shape resolveEmployeeDayHours
// takes, so both can be called side by side against the same inputs.
const oldFnSrc = `
function OLD_resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData) {
  var dk = dateKey(d);
  var dayTeam = getEmployeeTeam(empId, dk);
  if (!dayTeam) {
    return { dayTeam: null, isOff: true, hours: 0, startStr: '', endStr: '', lunchMin: 0, isOpenShift: false, isOverride: false };
  }
  var dayData = weekHoursData[dayTeam];
  var override = getEmpHours(empId, dk);
  var empMap = empHoursMapData[empId] || {};
  var teCell = empMap[dk] || null;
  var teamH = (dayData && Array.isArray(dayData.days)) ? (dayData.days[dayIdx] || 0) : 0;
  var teamSrc = dayData && dayData.source;
  var empH = override ? override.hours
    : (teCell ? teCell.hours : (teamSrc === 'time_entries' ? 0 : teamH));
  var isOpen = !!(teCell && teCell.openShift) && !override;

  var sStr = '', eStr = '';
  if (override) {
    if (override.start) sStr = _hrsFmt12(override.start);
    if (override.end) eStr = _hrsFmt12(override.end);
  } else if (teCell) {
    if (teCell.start) sStr = _hrsFmt12(teCell.start);
    if (teCell.end) eStr = _hrsFmt12(teCell.end);
  } else if (teamSrc !== 'time_entries') {
    if (dayData && dayData.starts && dayData.starts[dayIdx]) sStr = _hrsFmt12(dayData.starts[dayIdx]);
    if (dayData && dayData.ends && dayData.ends[dayIdx]) eStr = _hrsFmt12(dayData.ends[dayIdx]);
  }
  var lunchMin = override ? (override.lunch || 0)
    : (dayData && dayData.lunch && dayData.lunch[dayIdx] ? dayData.lunch[dayIdx].duration : 0);

  return { dayTeam: dayTeam, isOff: false, hours: empH, startStr: sStr, endStr: eStr, lunchMin: lunchMin, isOpenShift: isOpen, isOverride: !!override };
}
`;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -- expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}

function buildSandbox(deps) {
  const sandbox = Object.assign({
    console,
    dateKey: function (d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    _hrsFmt12: function (x) {
      if (x == null) return '';
      if (x instanceof Date) return x.toISOString();
      return String(x);
    },
  }, deps);
  vm.createContext(sandbox);
  vm.runInContext(oldFnSrc, sandbox);
  vm.runInContext(newFnSrc, sandbox);
  return sandbox;
}

function runBoth(sandbox, empId, d, dayIdx, weekHoursData, empHoursMapData) {
  const oldResult = sandbox.OLD_resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData);
  const newResult = sandbox.resolveEmployeeDayHours(empId, d, dayIdx, weekHoursData, empHoursMapData);
  // The new function additionally returns startDate/endDate (needed by
  // the portal) -- strip those before comparing, since the OLD formula
  // never had them; every OTHER field must match byte-for-byte.
  const { startDate, endDate, ...newComparable } = newResult;
  return { oldResult, newComparable };
}

const MON = new Date(2026, 7, 17); // a plain Monday, no DST/UTC edge cases

function main() {
  // ---- Scenario 1: OFF day (no team) ----
  {
    const sandbox = buildSandbox({ getEmployeeTeam: () => null, getEmpHours: () => null });
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, {}, {});
    check('OFF day: old and new agree', newComparable, oldResult);
  }

  // ---- Scenario 2: manual override wins over everything ----
  {
    const sandbox = buildSandbox({
      getEmployeeTeam: () => 'B1',
      getEmpHours: () => ({ hours: 7.5, start: '09:00', end: '16:30', lunch: 30 }),
    });
    const weekHoursData = { B1: { days: [8], starts: [new Date(MON.getTime() + 9 * 3600000)], ends: [new Date(MON.getTime() + 17 * 3600000)], lunch: [{ duration: 60 }], source: 'geotab' } };
    const empHoursMapData = { e1: { '2026-08-17': { hours: 99, start: new Date(), end: new Date(), openShift: false } } };
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, weekHoursData, empHoursMapData);
    check('manual override wins: old and new agree', newComparable, oldResult);
    check('manual override wins: hours is the override value, not the team or personal-cell value', newComparable.hours, 7.5);
  }

  // ---- Scenario 3: personal GPS/clock cell (teCell), no override, open shift ----
  {
    const sandbox = buildSandbox({ getEmployeeTeam: () => 'B1', getEmpHours: () => null });
    const weekHoursData = { B1: { days: [8], starts: [null], ends: [null], lunch: [null], source: 'time_entries' } };
    const empHoursMapData = { e1: { '2026-08-17': { hours: 4.2, start: new Date(MON.getTime() + 9 * 3600000), end: null, openShift: true } } };
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, weekHoursData, empHoursMapData);
    check('open personal shift: old and new agree', newComparable, oldResult);
    check('open shift flag propagates', newComparable.isOpenShift, true);
  }

  // ---- Scenario 4: no override, no personal cell, time_entries team source -> 0 (not the team average) ----
  {
    const sandbox = buildSandbox({ getEmployeeTeam: () => 'B1', getEmpHours: () => null });
    const weekHoursData = { B1: { days: [6.3], starts: [new Date()], ends: [new Date()], lunch: [null], source: 'time_entries' } };
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, weekHoursData, {});
    check('time_entries source with no personal cell: old and new agree (both 0, not the team total)', newComparable, oldResult);
    check('hours is 0, confirming the team total is never misattributed to an individual under time_entries', newComparable.hours, 0);
  }

  // ---- Scenario 5 (vehicle-swap day): team-aggregate fallback under a geotab source DOES apply ----
  {
    const sandbox = buildSandbox({ getEmployeeTeam: () => 'S3', getEmpHours: () => null }); // swapped onto S3 for the day
    const weekHoursData = {
      S3: { days: [5.5], starts: [new Date(MON.getTime() + 8 * 3600000)], ends: [new Date(MON.getTime() + 13.5 * 3600000)], lunch: [{ duration: 30 }], source: 'geotab' },
    };
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, weekHoursData, {});
    check('vehicle-swap day (geotab team fallback): old and new agree', newComparable, oldResult);
    check('vehicle-swap day: hours come from the SWAPPED team (S3), not any other team', newComparable.hours, 5.5);
    check('vehicle-swap day: lunch deduction carries through', newComparable.lunchMin, 30);
  }

  // ---- Scenario 6 (lunch deduction): lunch minutes surface correctly from the team blob ----
  {
    const sandbox = buildSandbox({ getEmployeeTeam: () => 'B1', getEmpHours: () => null });
    const weekHoursData = { B1: { days: [7], starts: [new Date()], ends: [new Date()], lunch: [{ duration: 45 }], source: 'geotab' } };
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, weekHoursData, {});
    check('lunch deduction: old and new agree', newComparable, oldResult);
    check('lunch minutes is 45', newComparable.lunchMin, 45);
  }

  // ---- Scenario 7 (crosses midnight in UTC): a shift starting 11:30 PM local, ending past UTC midnight ----
  {
    // 2026-08-17 23:30 local time is 2026-08-18 03:30Z in UTC-4 (EDT) --
    // a genuine UTC-day-boundary crossing for a late shift.
    const lateStart = new Date(2026, 7, 17, 23, 30, 0);
    const lateEnd = new Date(2026, 7, 18, 1, 15, 0); // 1:15 AM the next local day
    const sandbox = buildSandbox({ getEmployeeTeam: () => 'B1', getEmpHours: () => null });
    const weekHoursData = { B1: { days: [1.75], starts: [lateStart], ends: [lateEnd], lunch: [null], source: 'geotab' } };
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, weekHoursData, {});
    check('midnight-UTC-crossing shift: old and new agree exactly', newComparable, oldResult);
    // The new function's own startDate/endDate (portal-only fields) must
    // still be valid, round-trippable Date objects regardless of which
    // side of UTC midnight they fall on.
    const newFull = sandbox.resolveEmployeeDayHours('e1', MON, 0, weekHoursData, {});
    check('startDate is the real Date object, ISO-serializable with no throw', typeof newFull.startDate.toISOString(), 'string');
    check('endDate is the real Date object, ISO-serializable with no throw', typeof newFull.endDate.toISOString(), 'string');
    check('startDate/endDate preserve the actual instant (not shifted to the wrong UTC day)', [newFull.startDate.getTime(), newFull.endDate.getTime()], [lateStart.getTime(), lateEnd.getTime()]);
  }

  // ---- Scenario 8: manual override with only a start time (no end) -- partial data must not crash either version ----
  {
    const sandbox = buildSandbox({ getEmployeeTeam: () => 'B1', getEmpHours: () => ({ hours: 0, start: '09:00', end: '', lunch: 0 }) });
    const { oldResult, newComparable } = runBoth(sandbox, 'e1', MON, 0, { B1: { days: [0], starts: [null], ends: [null], lunch: [null], source: 'geotab' } }, {});
    check('partial override (start only): old and new agree', newComparable, oldResult);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main();
