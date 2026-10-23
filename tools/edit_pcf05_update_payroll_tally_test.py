#!/usr/bin/env python3
"""Update the existing payroll-cost-tally test to match the corrected
_computeWeekPayroll scope: Admin/Office (Linda, hourly) is now entirely
out of this card's scope (flagged via hasHourlyAdmin), and a field
employee with no pay rate (NoRate) now DOES count toward total hours --
only toward pay is she excluded. This is a generic, uniqueness-checked
string replacement, same discipline as tools/_apply_edits.py, just not
scoped to index.html."""
import sys

PATH = "tests/payroll-cost-tally.test.js"


def replace_once(content, old, new, label):
    count = content.count(old)
    if count == 0:
        raise SystemExit(f"FAIL [{label}]: old string not found at all")
    if count > 1:
        raise SystemExit(f"FAIL [{label}]: old string found {count} times (expected exactly 1)")
    return content.replace(old, new, 1)


with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()

OLD_A = """    const elvia = result.included.find(function (e) { return e.empId === ELVIA_UUID; });
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
    check('total gross cents = sum of every included employee\\'s gross', result.totalGrossCents, expectedTotalCents);"""

NEW_A = """    const elvia = result.included.find(function (e) { return e.empId === ELVIA_UUID; });
    const pat = result.salaried.find(function (e) { return e.empId === PAT_UUID; });
    const rosa = result.included.find(function (e) { return e.empId === ROSA_UUID; });
    const norate = result.missingRate.find(function (e) { return e.empId === NORATE_UUID; });
    const linda = result.perEmployee.find(function (e) { return e.empId === LINDA_UUID; });

    check('overtime OFF: Elvia 45h total', elvia.hours, 45);
    check('overtime OFF: Elvia gross is straight 45*$20, no 1.5x', elvia.grossCents, 45 * 20 * 100);
    // Payroll cost card bug fix: Admin/Office (Linda, hourly) is out of
    // scope for this card entirely now -- the Hours table's own "All
    // Teams" total never includes Admin/Office hours either, so
    // matching it EXACTLY means matching its scope, not folding her in.
    check('Linda (hourly admin) never appears in perEmployee at all', !!linda, false);
    check('hasHourlyAdmin is true -- an hourly Admin/Office employee exists this week', result.hasHourlyAdmin, true);
    check('Pat (salaried) is listed separately, not in perEmployee at all', !!pat, true);
    check('Pat never appears in perEmployee either (salaried has no hours to report)', result.perEmployee.some(function (e) { return e.empId === PAT_UUID; }), false);
    check('Rosa (terminated Wed): only Mon+Tue counted, 16h', rosa.hours, 16);
    check('Rosa gross: 16 * $18', rosa.grossCents, 16 * 18 * 100);
    check('NoRate employee is listed under missing-rate, not included', !!norate, true);
    check('NoRate contributes zero to the GROSS total (no rate on file -- never excluded from HOURS, only from pay)', result.perEmployee.some(function (e) { return e.empId === NORATE_UUID && e.status === 'included'; }), false);

    // The exact bug this PR fixes: "total hours" used to sum ONLY
    // included (rated) employees. It must now be every FIELD employee
    // this week, rated or not -- Elvia + Rosa + NoRate.
    const expectedTotalHours = elvia.hours + rosa.hours + norate.hours;
    check('total hours = every field employee this week, rated or not (NoRate\\'s hours are counted)', result.totalHours, expectedTotalHours);
    check('hoursWithRate = Elvia + Rosa (the rated field employees)', result.hoursWithRate, elvia.hours + rosa.hours);
    check('hoursWithoutRate = NoRate alone', result.hoursWithoutRate, norate.hours);
    const expectedTotalCents = elvia.grossCents + rosa.grossCents;
    check('total gross cents = sum of every included (rated, field) employee\\'s gross -- Linda excluded by scope, not silently zeroed', result.totalGrossCents, expectedTotalCents);"""

content = replace_once(content, OLD_A, NEW_A, "overtime-OFF block: field-only scope assertions")

OLD_B = """    let manualTotal = 0;
    ['elvia-legacy', 'rosa-legacy'].forEach(function (empId) {
      days.forEach(function (d, i) {
        var rd = sandbox2.resolveEmployeeDayHours(empId, d, i);
        var dk2 = dk(d);
        var inRoster = sandbox2.getUnifiedRoster(dk2).some(function (e) { return e.id === empId; });
        if (inRoster && !rd.isOff) manualTotal += rd.hours;
      });
    });
    manualTotal += 6; // Linda's override
    check('payroll tally\\'s total hours equal hand-summed resolveEmployeeDayHours totals for the same fixture', result.totalHours, manualTotal);"""

NEW_B = """    let manualTotal = 0;
    // Field employees only -- Linda (admin) is out of this card's
    // scope by design now, same as the Hours table's own "All Teams"
    // total. NoRate is included here too: no pay rate no longer means
    // no hours.
    ['elvia-legacy', 'rosa-legacy', 'norate-legacy'].forEach(function (empId) {
      days.forEach(function (d, i) {
        var rd = sandbox2.resolveEmployeeDayHours(empId, d, i);
        var dk2 = dk(d);
        var inRoster = sandbox2.getUnifiedRoster(dk2).some(function (e) { return e.id === empId; });
        if (inRoster && !rd.isOff) manualTotal += rd.hours;
      });
    });
    check('payroll tally\\'s total hours equal hand-summed resolveEmployeeDayHours totals for the same fixture (field employees only, rated or not)', result.totalHours, manualTotal);"""

content = replace_once(content, OLD_B, NEW_B, "consistency block: field-only manual total")

with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("Applied 2 edit(s) to", PATH)
