#!/usr/bin/env python3
"""Payroll cost tally feature. Inserts the shared payroll-computation
helpers (_getPayrollSettings, _computeDayPayCents, _employerTaxPct,
_computeWeekPayroll) right before publishWeekHours, and extends
publishWeekHours itself to snapshot est_rate/est_gross onto every
'worked' day using the SAME _computeDayPayCents function the payroll
cost card uses for display -- never a second calculation. Also extends
the existing diff-check (_sameRow) to compare est_rate/est_gross, so a
pure pay-rate change (no hours change) still triggers a rewrite through
the EXISTING "Publish now" button -- no separate "Republish week" button
needed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function publishWeekHours(days, weekHoursData, empHoursMapData) {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  var bid = (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null;
  if (!sb || !bid) throw new Error('Not connected -- cannot publish hours.');

  var currentUserId = (window.PentaAuth && window.PentaAuth.session && window.PentaAuth.session.user && window.PentaAuth.session.user.id) || null;
  if (!currentUserId) {
    try { var ures = await sb.auth.getUser(); currentUserId = ures && ures.data && ures.data.user && ures.data.user.id; } catch (e) {}
  }

  var todayKey = dateKey(new Date());
  var now = new Date();
  var candidates = [];
  var skipped = [];

  days.forEach(function (d, dayIdx) {
    if (d > now) return; // never publish a day that hasn't happened yet
    var dk = dateKey(d);
    var roster = getUnifiedRoster(dk);
    roster.forEach(function (emp) {
      var empUuid = emp.uuid || emp.id;
      if (!_isUuidLike(empUuid)) { skipped.push({ emp: emp.name, date: dk, reason: 'no resolvable uuid' }); return; }
      var base = { business_id: bid, employee_id: empUuid, work_date: dk, published_by: currentUserId };

      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: null, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: 'salaried', source: null }) });
        return;
      }

      if (emp.work_type === 'admin') {
        var offInfo = _adminEmpDayOff(emp.id, dk);
        if (offInfo) {
          candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: 0, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: (offInfo.status_type === 'vacation' ? 'vacation' : 'off'), source: null }) });
          return;
        }
        var override = getEmpHours(emp.id, dk);
        if (!override) { if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'no manual hours on file' }); return; }
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, {
          hours: override.hours || 0, start_time: _toInstant(d, override.start), end_time: _toInstant(d, override.end),
          lunch_minutes: override.lunch || 0, team_label: null, status: 'worked', source: 'manual'
        }) });
        return;
      }

      // Field employee -- the exact function renderHoursTable itself reads.
      var rd = resolveEmployeeDayHours(emp.id, d, dayIdx, weekHoursData, empHoursMapData);
      if (rd.isOff) {
        var fOffInfo = (typeof getEmployeeDayOffInfo === 'function') ? getEmployeeDayOffInfo(emp.id, dk) : null;
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: 0, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: (fOffInfo && fOffInfo.status_type === 'vacation' ? 'vacation' : 'off'), source: null }) });
        return;
      }
      // An unresolved ambiguous zero (no override, no personal GPS/clock
      // cell, team's own source is time_entries) means "no data yet", not
      // a verified zero-hour day -- never publish a fake zero. A REAL
      // override of 0 is a deliberate manager entry and still publishes
      // (isOverride is what tells the two apart).
      if (rd.hours === 0 && !rd.isOverride) {
        if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'unresolved -- no GPS/clock data yet' });
        return;
      }
      candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, {
        hours: rd.hours, start_time: rd.startDate ? rd.startDate.toISOString() : null, end_time: rd.endDate ? rd.endDate.toISOString() : null,
        lunch_minutes: rd.lunchMin || 0, team_label: rd.dayTeam || null, status: 'worked', source: rd.isOverride ? 'override' : 'gps'
      }) });
    });
  });

  if (!candidates.length) return { published: 0, skipped: skipped.length, skippedDetail: skipped };

  // Diff against what's already published: only changed/new rows are
  // written, so published_at (the employee-visible "Updated" time) only
  // moves when a value actually changed -- not on every routine 60s Live
  // recompute, which would otherwise bump it constantly for no reason.
  var mon = dateKey(days[0]), fri = dateKey(days[days.length - 1]);
  var existingRes = await sb.from('published_employee_hours')
    .select('employee_id, work_date, hours, start_time, end_time, lunch_minutes, team_label, status, source')
    .eq('business_id', bid).gte('work_date', mon).lte('work_date', fri);
  if (existingRes.error) throw new Error('Could not read current published hours before publishing: ' + existingRes.error.message);
  var existingByKey = {};
  (existingRes.data || []).forEach(function (r) { existingByKey[r.employee_id + '|' + r.work_date] = r; });

  function _sameRow(a, b) {
    return a.hours == b.hours && a.start_time == b.start_time && a.end_time == b.end_time
      && a.lunch_minutes == b.lunch_minutes && a.team_label == b.team_label && a.status == b.status && a.source == b.source;
  }

  var toWrite = candidates.filter(function (c) {
    var existing = existingByKey[c.key];
    return !existing || !_sameRow(existing, c.row);
  }).map(function (c) { return c.row; });

  if (!toWrite.length) return { published: 0, skipped: skipped.length, skippedDetail: skipped, unchanged: candidates.length };

  var CHUNK = 200;
  var publishedCount = 0;
  for (var i = 0; i < toWrite.length; i += CHUNK) {
    var chunk = toWrite.slice(i, i + CHUNK);
    var res = await sb.from('published_employee_hours').upsert(chunk, { onConflict: 'business_id,employee_id,work_date' });
    if (res.error) throw new Error('Publish failed partway through (' + publishedCount + '/' + toWrite.length + ' rows written): ' + res.error.message);
    publishedCount += chunk.length;
  }
  return { published: publishedCount, skipped: skipped.length, skippedDetail: skipped };
}"""

NEW = """// ═══════════════════════════════════════════════════════════════════════
// Payroll cost tally feature (migrations 117/118).
//
// _computeDayPayCents is the ONE place gross pay is ever computed, in
// CENTS (integer), rounded once at the end -- used by BOTH
// publishWeekHours (to snapshot est_rate/est_gross) and the payroll
// cost card (for live display of the currently-viewed week, published
// or not). Overtime, when enabled, is split within the 5 displayed
// Mon-Fri days ONLY -- not a true Monday-Sunday pay week. See migration
// 117's own "OVERTIME SCOPE" comment for why: getWeekDates() never
// returns Saturday/Sunday, and nothing in this app surfaces a weekend
// hour anywhere today, so true 7-day overtime cannot be computed
// correctly yet. This is a disclosed limitation, not an oversight.
function _computeDayPayCents(hoursToday, rate, cumHoursBeforeToday, overtimeEnabled) {
  if (!overtimeEnabled) return Math.round(hoursToday * rate * 100);
  var regularCap = 40;
  var before = cumHoursBeforeToday || 0;
  var after = before + hoursToday;
  if (before >= regularCap) {
    return Math.round(hoursToday * rate * 1.5 * 100);
  } else if (after <= regularCap) {
    return Math.round(hoursToday * rate * 100);
  } else {
    var regularPortion = regularCap - before;
    var otPortion = hoursToday - regularPortion;
    return Math.round((regularPortion * rate + otPortion * rate * 1.5) * 100);
  }
}

// One combined employer-tax percentage, or null if ANY of the 5 rate
// fields hasn't been entered yet -- "no default values, nothing is
// estimated until Tom enters it" means a partially-filled settings row
// must never silently compute a partial total that looks complete.
function _employerTaxPct(settings) {
  if (!settings) return null;
  var fields = [settings.social_security_pct, settings.medicare_pct, settings.federal_unemployment_pct, settings.state_unemployment_pct, settings.other_employer_costs_pct];
  if (fields.some(function (f) { return f == null; })) return null;
  return fields.reduce(function (s, f) { return s + f; }, 0);
}

var _payrollSettingsCache = null;
var _payrollSettingsCacheAt = 0;
// Cached 60s -- cheap enough to re-fetch on every publish/card-render,
// but avoids a network round trip on every single keystroke-driven
// re-render of the payroll card while a manager has the Hours tab open.
async function _getPayrollSettings() {
  var now = Date.now();
  if (_payrollSettingsCache && (now - _payrollSettingsCacheAt) < 60000) return _payrollSettingsCache;
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  var bid = (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null;
  if (!sb || !bid) return null;
  try {
    var res = await sb.from('business_payroll_settings')
      .select('social_security_pct, medicare_pct, federal_unemployment_pct, state_unemployment_pct, other_employer_costs_pct, overtime_enabled')
      .eq('business_id', bid).maybeSingle();
    if (res.error) { console.warn('[payroll] could not load business_payroll_settings', res.error); return null; }
    _payrollSettingsCache = res.data || { overtime_enabled: false };
    _payrollSettingsCacheAt = now;
    return _payrollSettingsCache;
  } catch (e) { console.warn('[payroll] business_payroll_settings fetch threw', e); return null; }
}

// Shared payroll computation -- the Hours tab's "Payroll cost this
// week" card and publishWeekHours's own est_rate/est_gross snapshot
// both call this, so there is exactly one place gross pay is ever
// computed from hours+rate, never two copies that could diverge.
// Reads resolveEmployeeDayHours/getEmpHours the SAME way
// renderHoursTable/publishWeekHours already do -- never a second
// calculation of HOURS, only of pay.
function _computeWeekPayroll(days, weekHoursData, empHoursMapData, payrollSettings) {
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
}

async function publishWeekHours(days, weekHoursData, empHoursMapData) {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  var bid = (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null;
  if (!sb || !bid) throw new Error('Not connected -- cannot publish hours.');

  var currentUserId = (window.PentaAuth && window.PentaAuth.session && window.PentaAuth.session.user && window.PentaAuth.session.user.id) || null;
  if (!currentUserId) {
    try { var ures = await sb.auth.getUser(); currentUserId = ures && ures.data && ures.data.user && ures.data.user.id; } catch (e) {}
  }

  // Payroll cost tally feature: fetched once per run, used to snapshot
  // est_rate/est_gross onto every worked day below via the SAME
  // _computeDayPayCents function the payroll cost card uses for
  // display. A failure here is non-fatal -- est_rate/est_gross just
  // stay null for this run (same as "no pay rate on file").
  var payrollSettings = null;
  try { payrollSettings = await _getPayrollSettings(); } catch (e) { console.warn('[publish] could not load payroll settings (non-fatal)', e); }
  var overtimeEnabled = !!(payrollSettings && payrollSettings.overtime_enabled);

  var todayKey = dateKey(new Date());
  var now = new Date();
  var candidates = [];
  var skipped = [];
  // Cumulative hours per employee, carried forward day-to-day IN ORDER
  // (days[] is already Mon..Fri) so a shift crossing the 40-hour line
  // splits correctly. Declared outside the days loop so it persists.
  var cumHoursByEmp = {};

  days.forEach(function (d, dayIdx) {
    if (d > now) return; // never publish a day that hasn't happened yet
    var dk = dateKey(d);
    var roster = getUnifiedRoster(dk);
    roster.forEach(function (emp) {
      var empUuid = emp.uuid || emp.id;
      if (!_isUuidLike(empUuid)) { skipped.push({ emp: emp.name, date: dk, reason: 'no resolvable uuid' }); return; }
      var base = { business_id: bid, employee_id: empUuid, work_date: dk, published_by: currentUserId };

      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: null, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: 'salaried', source: null, est_rate: null, est_gross: null }) });
        return;
      }

      if (emp.work_type === 'admin') {
        var offInfo = _adminEmpDayOff(emp.id, dk);
        if (offInfo) {
          candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: 0, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: (offInfo.status_type === 'vacation' ? 'vacation' : 'off'), source: null, est_rate: null, est_gross: null }) });
          return;
        }
        var override = getEmpHours(emp.id, dk);
        if (!override) { if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'no manual hours on file' }); return; }
        var adminHrs = override.hours || 0;
        var adminCumBefore = cumHoursByEmp[empUuid] || 0;
        var adminPay = (emp.pay_rate != null && adminHrs > 0) ? _computeDayPayCents(adminHrs, emp.pay_rate, adminCumBefore, overtimeEnabled) : null;
        cumHoursByEmp[empUuid] = adminCumBefore + adminHrs;
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, {
          hours: adminHrs, start_time: _toInstant(d, override.start), end_time: _toInstant(d, override.end),
          lunch_minutes: override.lunch || 0, team_label: null, status: 'worked', source: 'manual',
          est_rate: emp.pay_rate != null ? emp.pay_rate : null, est_gross: adminPay
        }) });
        return;
      }

      // Field employee -- the exact function renderHoursTable itself reads.
      var rd = resolveEmployeeDayHours(emp.id, d, dayIdx, weekHoursData, empHoursMapData);
      if (rd.isOff) {
        var fOffInfo = (typeof getEmployeeDayOffInfo === 'function') ? getEmployeeDayOffInfo(emp.id, dk) : null;
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: 0, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: (fOffInfo && fOffInfo.status_type === 'vacation' ? 'vacation' : 'off'), source: null, est_rate: null, est_gross: null }) });
        return;
      }
      // An unresolved ambiguous zero (no override, no personal GPS/clock
      // cell, team's own source is time_entries) means "no data yet", not
      // a verified zero-hour day -- never publish a fake zero. A REAL
      // override of 0 is a deliberate manager entry and still publishes
      // (isOverride is what tells the two apart).
      if (rd.hours === 0 && !rd.isOverride) {
        if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'unresolved -- no GPS/clock data yet' });
        return;
      }
      var fieldCumBefore = cumHoursByEmp[empUuid] || 0;
      var fieldPay = (emp.pay_rate != null && rd.hours > 0) ? _computeDayPayCents(rd.hours, emp.pay_rate, fieldCumBefore, overtimeEnabled) : null;
      cumHoursByEmp[empUuid] = fieldCumBefore + rd.hours;
      candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, {
        hours: rd.hours, start_time: rd.startDate ? rd.startDate.toISOString() : null, end_time: rd.endDate ? rd.endDate.toISOString() : null,
        lunch_minutes: rd.lunchMin || 0, team_label: rd.dayTeam || null, status: 'worked', source: rd.isOverride ? 'override' : 'gps',
        est_rate: emp.pay_rate != null ? emp.pay_rate : null, est_gross: fieldPay
      }) });
    });
  });

  if (!candidates.length) return { published: 0, skipped: skipped.length, skippedDetail: skipped };

  // Diff against what's already published: only changed/new rows are
  // written, so published_at (the employee-visible "Updated" time) only
  // moves when a value actually changed -- not on every routine 60s Live
  // recompute, which would otherwise bump it constantly for no reason.
  // Payroll cost tally feature: est_rate/est_gross are now part of this
  // diff too, so a pure pay-rate change (no hours change at all) still
  // triggers a rewrite through the EXISTING "Publish now" button -- no
  // separate "Republish week" button needed.
  var mon = dateKey(days[0]), fri = dateKey(days[days.length - 1]);
  var existingRes = await sb.from('published_employee_hours')
    .select('employee_id, work_date, hours, start_time, end_time, lunch_minutes, team_label, status, source, est_rate, est_gross')
    .eq('business_id', bid).gte('work_date', mon).lte('work_date', fri);
  if (existingRes.error) throw new Error('Could not read current published hours before publishing: ' + existingRes.error.message);
  var existingByKey = {};
  (existingRes.data || []).forEach(function (r) { existingByKey[r.employee_id + '|' + r.work_date] = r; });

  function _sameRow(a, b) {
    return a.hours == b.hours && a.start_time == b.start_time && a.end_time == b.end_time
      && a.lunch_minutes == b.lunch_minutes && a.team_label == b.team_label && a.status == b.status && a.source == b.source
      && a.est_rate == b.est_rate && a.est_gross == b.est_gross;
  }

  var toWrite = candidates.filter(function (c) {
    var existing = existingByKey[c.key];
    return !existing || !_sameRow(existing, c.row);
  }).map(function (c) { return c.row; });

  if (!toWrite.length) return { published: 0, skipped: skipped.length, skippedDetail: skipped, unchanged: candidates.length };

  var CHUNK = 200;
  var publishedCount = 0;
  for (var i = 0; i < toWrite.length; i += CHUNK) {
    var chunk = toWrite.slice(i, i + CHUNK);
    var res = await sb.from('published_employee_hours').upsert(chunk, { onConflict: 'business_id,employee_id,work_date' });
    if (res.error) throw new Error('Publish failed partway through (' + publishedCount + '/' + toWrite.length + ' rows written): ' + res.error.message);
    publishedCount += chunk.length;
  }
  return { published: publishedCount, skipped: skipped.length, skippedDetail: skipped };
}"""

EDITS = [("Insert payroll helpers + extend publishWeekHours with est_rate/est_gross", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
