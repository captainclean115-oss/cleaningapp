#!/usr/bin/env python3
"""Payroll cost card bug fix, step 1: _computeWeekPayroll.

ROOT CAUSE (confirmed against real production data for 2026-10-12 to
2026-10-16): "Total hours" used to sum ONLY employees whose perEmployee
status was 'included' -- i.e. only employees with pay_rate > 0. 22 of
25 active employees have pay_rate NULL or 0.00 (a bulk-import default,
not a deliberate $0/hr wage). Only one employee (Blanca Payan, rate
$22, 29.23h that week) was ever counted -- exactly the card's reported
29.23 total, while the real "All Teams" total for everyone was 728.09h
(728.1 rounded).

FIX: Admin/Office employees are split out FIRST (the Hours table's own
"All Teams" total never includes them either -- that's a separate
card, renderHoursTable's adminTotal is never added to grandTotal, so
matching it exactly means matching its scope too, not just its number
on one lucky week). Salaried admins are still named (via the new
`salaried` list) for the card's "Salaried (not included in pay)" line.
An hourly Admin/Office employee flips `hasHourlyAdmin` instead of being
silently folded into the total or silently dropped with no trace.

Within the remaining field/team population, pay-rate status no longer
gates HOURS at all -- only PAY. totalHours sums every field employee's
hours regardless of rate; hoursWithRate/hoursWithoutRate are the new
breakdown the card displays.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD = """function _computeWeekPayroll(days, weekHoursData, empHoursMapData, payrollSettings) {
  var overtimeEnabled = !!(payrollSettings && payrollSettings.overtime_enabled);
  var todayKey = dateKey(new Date());
  var now = new Date();

  // Union of every employee who appears in the roster on ANY day this
  // week -- handles a mid-week termination correctly (she's included
  // for the days before her exclusion date, same as publishWeekHours).
  var empsByUuid = {};
  days.forEach(function (d) {
    if (d > now) return;
    getUnifiedRoster(dateKey(d)).forEach(function (emp) {
      var key = emp.uuid || emp.id;
      if (!empsByUuid[key]) empsByUuid[key] = emp;
    });
  });

  var perEmployee = [];
  Object.keys(empsByUuid).forEach(function (key) {
    var emp = empsByUuid[key];
    if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
      perEmployee.push({ empId: key, name: emp.name, status: 'salaried', hours: 0, grossCents: null });
      return;
    }
    var rate = (emp.pay_rate != null && emp.pay_rate > 0) ? emp.pay_rate : null;
    var totalHours = 0, totalGrossCents = 0, cumBefore = 0, anyDayIncluded = false;
    days.forEach(function (d, dayIdx) {
      if (d > now) return;
      var dk = dateKey(d);
      var inRosterToday = getUnifiedRoster(dk).some(function (e) { return (e.uuid || e.id) === key; });
      if (!inRosterToday) return; // terminated before this date, or hired after it
      var hrs;
      if (emp.work_type === 'admin') {
        var offInfo = _adminEmpDayOff(emp.id, dk);
        if (offInfo) { hrs = 0; }
        else {
          var override = getEmpHours(emp.id, dk);
          if (!override) return; // nothing on file -- not counted, not a fake zero
          hrs = override.hours || 0;
        }
      } else {
        var rd = resolveEmployeeDayHours(emp.id, d, dayIdx, weekHoursData, empHoursMapData);
        if (rd.isOff) { hrs = 0; }
        else if (rd.hours === 0 && !rd.isOverride) { return; } // unresolved -- same skip rule as publishWeekHours
        else { hrs = rd.hours; }
      }
      anyDayIncluded = true;
      totalHours += hrs;
      if (rate != null && hrs > 0) totalGrossCents += _computeDayPayCents(hrs, rate, cumBefore, overtimeEnabled);
      cumBefore += hrs;
    });
    if (!anyDayIncluded) return; // nothing at all this week for her -- omit entirely
    perEmployee.push({
      empId: key, name: emp.name,
      status: rate == null ? 'missing_rate' : 'included',
      hours: totalHours,
      grossCents: rate == null ? null : totalGrossCents
    });
  });

  var included = perEmployee.filter(function (e) { return e.status === 'included'; });
  var missingRate = perEmployee.filter(function (e) { return e.status === 'missing_rate'; });
  var salaried = perEmployee.filter(function (e) { return e.status === 'salaried'; });
  return {
    perEmployee: perEmployee, included: included, missingRate: missingRate, salaried: salaried,
    totalHours: included.reduce(function (s, e) { return s + e.hours; }, 0),
    totalGrossCents: included.reduce(function (s, e) { return s + (e.grossCents || 0); }, 0)
  };
}"""

NEW = """function _computeWeekPayroll(days, weekHoursData, empHoursMapData, payrollSettings) {
  var overtimeEnabled = !!(payrollSettings && payrollSettings.overtime_enabled);
  var now = new Date();

  // Union of every employee who appears in the roster on ANY day this
  // week -- handles a mid-week termination correctly (she's included
  // for the days before her exclusion date, same as publishWeekHours).
  var empsByUuid = {};
  days.forEach(function (d) {
    if (d > now) return;
    getUnifiedRoster(dateKey(d)).forEach(function (emp) {
      var key = emp.uuid || emp.id;
      if (!empsByUuid[key]) empsByUuid[key] = emp;
    });
  });

  // Payroll cost card bug fix: Admin/Office is split out BEFORE any
  // hours are resolved, not filtered out of the total afterward. The
  // Hours table's own "All Teams" total never includes Admin/Office
  // hours (that's a separate card -- renderHoursTable's adminTotal is
  // never added to grandTotal), so matching it EXACTLY means matching
  // its scope, not just its number on a week where admin happens to
  // have no hours on file. Salaried admins are still named below (no
  // hours to report, same as the Hours table's own "Salaried — no
  // hours tracked" row). An hourly Admin/Office employee's pay isn't
  // computed by this card yet -- flagged via hasHourlyAdmin so that
  // gap is visible, never silently folded in or silently dropped.
  var salaried = [];
  var hasHourlyAdmin = false;
  var fieldEmps = {};
  Object.keys(empsByUuid).forEach(function (key) {
    var emp = empsByUuid[key];
    if (emp.work_type === 'admin') {
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) salaried.push({ empId: key, name: emp.name });
      else hasHourlyAdmin = true;
      return;
    }
    fieldEmps[key] = emp;
  });

  var perEmployee = [];
  Object.keys(fieldEmps).forEach(function (key) {
    var emp = fieldEmps[key];
    // "Missing rate" covers both NULL (never entered) and exactly 0
    // (this business's bulk-import default for "not entered yet") --
    // neither is a real $0/hr wage, so both are excluded from PAY the
    // same way. Neither is EVER excluded from HOURS -- that exclusion
    // was the whole bug.
    var rate = (emp.pay_rate != null && emp.pay_rate > 0) ? emp.pay_rate : null;
    var totalHours = 0, totalGrossCents = 0, cumBefore = 0, anyDayIncluded = false;
    days.forEach(function (d, dayIdx) {
      if (d > now) return;
      var dk = dateKey(d);
      var inRosterToday = getUnifiedRoster(dk).some(function (e) { return (e.uuid || e.id) === key; });
      if (!inRosterToday) return; // terminated before this date, or hired after it
      var rd = resolveEmployeeDayHours(emp.id, d, dayIdx, weekHoursData, empHoursMapData);
      var hrs;
      if (rd.isOff) { hrs = 0; }
      else if (rd.hours === 0 && !rd.isOverride) { return; } // unresolved -- same skip rule as publishWeekHours
      else { hrs = rd.hours; }
      anyDayIncluded = true;
      totalHours += hrs;
      if (rate != null && hrs > 0) totalGrossCents += _computeDayPayCents(hrs, rate, cumBefore, overtimeEnabled);
      cumBefore += hrs;
    });
    if (!anyDayIncluded) return; // nothing at all this week for her -- omit entirely
    perEmployee.push({
      empId: key, name: emp.name,
      status: rate == null ? 'missing_rate' : 'included',
      hours: totalHours,
      grossCents: rate == null ? null : totalGrossCents
    });
  });

  var included = perEmployee.filter(function (e) { return e.status === 'included'; });
  var missingRate = perEmployee.filter(function (e) { return e.status === 'missing_rate'; });
  return {
    perEmployee: perEmployee, included: included, missingRate: missingRate, salaried: salaried,
    hasHourlyAdmin: hasHourlyAdmin,
    // Every field/team employee this week, included or not -- the
    // SAME population the Hours table's "All Teams" total covers, so
    // the two must always agree. renderPayrollCostCard cross-checks
    // this against the actual number the Hours table just rendered
    // (not a re-derivation of this same formula) and shows a visible
    // warning if they ever disagree.
    totalHours: perEmployee.reduce(function (s, e) { return s + e.hours; }, 0),
    hoursWithRate: included.reduce(function (s, e) { return s + e.hours; }, 0),
    hoursWithoutRate: missingRate.reduce(function (s, e) { return s + e.hours; }, 0),
    totalGrossCents: included.reduce(function (s, e) { return s + (e.grossCents || 0); }, 0)
  };
}"""

apply_edits([
    ("_computeWeekPayroll: field-only hours scope, never excludes a field employee's hours for lacking a pay rate", OLD, NEW),
])
