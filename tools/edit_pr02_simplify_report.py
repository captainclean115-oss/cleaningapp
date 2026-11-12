#!/usr/bin/env python3
"""Payroll report simplification -- STEP 2.

Tom's request: the payroll report (Hours tab -> Export Hours Report)
should show ONLY name and hours worked, "Last, First", sorted
alphabetically by last name.

DIAGNOSIS (STEP 2C, "same number the Hours tab shows"): the old
per-day computation here was its own hand-rolled duplicate of
renderHoursTable's logic, and that duplicate (a) never consulted the
employee's own per-employee GPS/clock cell (window._empHoursMap),
falling straight to the team aggregate whenever there was no manual
override, and (b) only counted a day toward the weekly total when it
ALSO had a complete start+end pair -- renderHoursTable's own total
(empWeekTotal += empH, right off resolveEmployeeDayHours) has neither
restriction. Both are now fixed by calling resolveEmployeeDayHours
directly -- the exact shared function the Hours tab itself uses -- so
this report's total can no longer silently diverge from it.

Also drops the old per-team grouping entirely (PR #186's "each
employee once, not once per team touched" problem can't recur at all
once there's no team-grouped display left to duplicate into).

New row shape: one row per employee with ANY hours in the range
(team employees via resolveEmployeeDayHours, Admin/Office via the
existing override-only logic, salaried Admin/Office correctly never
counted -- same as the Hours tab itself never shows them with a
number), sorted by _hrCompareByLastName, displayed "Last, First".
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// Actual text/CSV builder -- shared by both the fast path (current
// week, reused weekHours) and slow path (freshly computed range) in
// _buildHoursReportForDates, since both normalize to the exact same
// { days, starts, ends, lunch, total } shape sized to dates.length.
function _buildHoursReportFromData(dates, weekHoursData, teams) {
  var firstDate = new Date(dates[0] + 'T00:00:00');
  var lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
  var weekLabel = firstDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + '–' + lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  var fnameWeek = dates[0] + '_to_' + dates[dates.length - 1];

  var SEP_HEAVY = '═'.repeat(43);
  var SEP_THIN = '─'.repeat(43);

  var textLines = [];
  textLines.push(SEP_HEAVY);
  textLines.push('  HOURS REPORT');
  var _wBiz = (window.PentaTenant && window.PentaTenant.name && window.PentaTenant.name()) || '';
  textLines.push('  ' + weekLabel + (_wBiz ? ' · ' + _wBiz : ''));
  textLines.push(SEP_HEAVY);
  textLines.push('');

  var csvRows = [];
  csvRows.push('Employee,Team,Date,ClockIn,ClockOut,Lunch,HoursWorked');

  var grandHours = 0;
  var empsSeen = 0;

  // PR #186 -- each employee must appear ONCE, under their DEFAULT team,
  // with one combined weekly total -- exactly like the Live tab's Hours
  // Worked widget (renderHoursTable, PR #109 Item 1). This used to group
  // by `dates.some(dk => getEmployeeTeam(e.id, dk) === team)`, which
  // shows an employee under EVERY team they touched that week, each
  // section only populating ITS OWN days and blanking the rest as "OFF"
  // -- the per-DAY math was always correct (verified against real Katia
  // Mejia / Analia DeSouza data, every single day matched the Live tab
  // exactly), but a cross-team week got silently split into multiple
  // disconnected sections with separate subtotals. Confirmed live: Tom
  // saw "KATIA MEJIA (B1) — 22h 47m" and read that as her week total,
  // never noticing the separate "KATIA MEJIA (S3) — 6h 3m" section
  // later in the same report holding her other day -- the two together
  // (28h 50m) match the Live tab's 28.8h exactly. Fixed the same way
  // renderHoursTable does: resolve the REAL team worked EACH DAY
  // (dayTeam) independently of which team's card/section this employee
  // is grouped under, and label each day/CSV row with that real
  // dayTeam so a cross-team day still shows correctly, just once.
  teams.forEach(function (team) {
    // Terminated-employee date-awareness fix: dates[0] (the first day of
    // the range) is getUnifiedRoster's asOfDate here -- an employee not
    // yet terminated as of that day belongs in this report at all, even
    // if she left partway through the range. _hrsEffectiveTeamForRange
    // groups her under the team she actually worked (not her now-cleared
    // default team) without reintroducing PR #186's old per-team-touched
    // duplicate-row bug.
    var teamEmployees = getUnifiedRoster(dates[0]).filter(function (e) {
      return _hrsEffectiveTeamForRange(e, dates) === team && dates.some(function (dk) { return !!getEmployeeTeam(e.id, dk); });
    });
    if (teamEmployees.length === 0) return;

    teamEmployees.forEach(function (emp) {
      empsSeen++;
      var empWeekHours = 0;
      var dayRows = [];

      dates.forEach(function (dk, dayIdx) {
        var d = new Date(dk + 'T00:00:00');
        var dayTeam = getEmployeeTeam(emp.id, dk); // the team ACTUALLY worked this date -- may differ from `team` (this card's default) on days worked elsewhere
        var data = dayTeam ? weekHoursData[dayTeam] : null;
        var override = getEmpHours(emp.id, dk);

        var teamH = data ? (data.days[dayIdx] || 0) : 0;
        var teamStart = data ? data.starts[dayIdx] : null;
        var teamEnd = data ? data.ends[dayIdx] : null;
        var teamLunchMin = (data && data.lunch && data.lunch[dayIdx]) ? (data.lunch[dayIdx].duration || 0) : 0;

        var empH = !dayTeam ? 0 : (override ? (override.hours || 0) : teamH);
        var startStr = !dayTeam ? '' : (override ? (override.start || '') : _hrTo24hr(teamStart));
        var endStr = !dayTeam ? '' : (override ? (override.end || '') : _hrTo24hr(teamEnd));
        var lunchMin = !dayTeam ? 0 : (override ? (override.lunch || 0) : teamLunchMin);

        if ((startStr && endStr) && empH <= 0) {
          console.warn('[HoursReport] non-positive duration for', emp.name, dk, { startStr: startStr, endStr: endStr, empH: empH });
          empH = 0;
        }

        var dateISO = dk;
        var dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        var rowTeam = dayTeam || team;

        if (empH > 0 && startStr && endStr) {
          empWeekHours += empH;
          var timeRange = startStr + ' – ' + endStr;
          var durTxt = _hrDecimalHoursText(empH);
          var lunchTail = lunchMin ? ('lunch ' + Math.floor(lunchMin / 60) + ':' + String(lunchMin % 60).padStart(2, '0')) : '';
          var crossTeamTag = dayTeam && dayTeam !== team ? (' [' + dayTeam + ']') : '';
          dayRows.push('  ' + dayLabel.padEnd(14) + timeRange.padEnd(16) + durTxt.padEnd(10) + lunchTail + crossTeamTag);
          csvRows.push([
            _hrCsvField(emp.name || emp.id), _hrCsvField(rowTeam), dateISO,
            _hrTo24hr(startStr), _hrTo24hr(endStr), _hrMinsToHHMM(lunchMin), _hrDecimalHoursToHHMM(empH)
          ].join(','));
        } else if ((startStr && !endStr) || (!startStr && endStr)) {
          dayRows.push('  ' + dayLabel.padEnd(14) + '? (incomplete clock data)');
          csvRows.push([_hrCsvField(emp.name || emp.id), _hrCsvField(rowTeam), dateISO, '', '', '', '0:00'].join(','));
        } else {
          dayRows.push('  ' + dayLabel.padEnd(14) + 'OFF');
          csvRows.push([_hrCsvField(emp.name || emp.id), _hrCsvField(rowTeam), dateISO, '', '', '', '0:00'].join(','));
        }
      });

      if (empsSeen > 1) textLines.push(SEP_THIN);
      textLines.push((emp.name || emp.id).toUpperCase() + ' (' + team + ') — ' + _hrDecimalHoursText(empWeekHours));
      dayRows.forEach(function (row) { textLines.push(row); });
      grandHours += empWeekHours;
    });
  });

  // Admin / Office section (migration 113) -- own try/catch so one bad
  // admin row can't blank the whole report; every team section above
  // has already been built successfully by this point. No team-
  // aggregate GPS data read at all here -- getEmpHours per day only,
  // blank (not zero, not an error) when nothing's on file, exactly
  // like the Live tab's Admin/Office group. Included in the SAME
  // grandHours/empsSeen totals the team sections feed -- this is one
  // combined report, not two.
  try {
    var adminEmployees = getUnifiedRoster(dates[0]).filter(function (e) { return e.work_type === 'admin'; });
    if (adminEmployees.length > 0) {
      textLines.push(SEP_THIN);
      textLines.push('  ADMIN / OFFICE');
      adminEmployees.forEach(function (emp) {
        empsSeen++;
        // Salaried Admin/Office: no hours cells, no CSV rows at all --
        // there's nothing day-shaped to report for them, so this
        // returns before the day loop even starts rather than
        // producing a run of zeroed rows. Counted in empsSeen (a real
        // employee appeared in this report) but never in grandHours.
        if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
          if (empsSeen > 1) textLines.push(SEP_THIN);
          textLines.push((emp.name || emp.id).toUpperCase() + ' (Admin, Salaried) — no hours tracked');
          return;
        }
        var empWeekHours = 0;
        var dayRows = [];

        dates.forEach(function (dk) {
          var d = new Date(dk + 'T00:00:00');
          var dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          // Terminated-employee date-awareness fix: same reasoning as
          // the Hours table's admin branch -- manual_hour_overrides has
          // no built-in cutoff at termination, so force-blank any day
          // on/after her exclusion date explicitly.
          if (_employeeExcludedAsOf(emp, dk)) {
            dayRows.push('  ' + dayLabel.padEnd(14) + '—');
            csvRows.push([_hrCsvField(emp.name || emp.id), 'Admin', dk, '', '', '', '0:00'].join(','));
            return;
          }
          var offInfo = _adminEmpDayOff(emp.id, dk);
          if (offInfo) {
            dayRows.push('  ' + dayLabel.padEnd(14) + offInfo.label.toUpperCase());
            csvRows.push([_hrCsvField(emp.name || emp.id), 'Admin', dk, '', '', '', '0:00'].join(','));
            return;
          }

          var override = getEmpHours(emp.id, dk);
          if (!override) {
            dayRows.push('  ' + dayLabel.padEnd(14) + '—'); // no override on file -- blank, not 0, not OFF
            csvRows.push([_hrCsvField(emp.name || emp.id), 'Admin', dk, '', '', '', '0:00'].join(','));
            return;
          }

          var empH = override.hours || 0;
          var startStr = override.start || '';
          var endStr = override.end || '';
          var lunchMin = override.lunch || 0;
          if (empH > 0 && startStr && endStr) {
            empWeekHours += empH;
            var timeRange = startStr + ' – ' + endStr;
            var durTxt = _hrDecimalHoursText(empH);
            var lunchTail = lunchMin ? ('lunch ' + Math.floor(lunchMin / 60) + ':' + String(lunchMin % 60).padStart(2, '0')) : '';
            dayRows.push('  ' + dayLabel.padEnd(14) + timeRange.padEnd(16) + durTxt.padEnd(10) + lunchTail);
            csvRows.push([
              _hrCsvField(emp.name || emp.id), 'Admin', dk,
              _hrTo24hr(startStr), _hrTo24hr(endStr), _hrMinsToHHMM(lunchMin), _hrDecimalHoursToHHMM(empH)
            ].join(','));
          } else if ((startStr && !endStr) || (!startStr && endStr)) {
            dayRows.push('  ' + dayLabel.padEnd(14) + '? (incomplete entry)');
            csvRows.push([_hrCsvField(emp.name || emp.id), 'Admin', dk, '', '', '', '0:00'].join(','));
          } else {
            dayRows.push('  ' + dayLabel.padEnd(14) + '—');
            csvRows.push([_hrCsvField(emp.name || emp.id), 'Admin', dk, '', '', '', '0:00'].join(','));
          }
        });

        if (empsSeen > 1) textLines.push(SEP_THIN);
        textLines.push((emp.name || emp.id).toUpperCase() + ' (Admin) — ' + _hrDecimalHoursText(empWeekHours));
        dayRows.forEach(function (row) { textLines.push(row); });
        grandHours += empWeekHours;
      });
    }
  } catch (e) {
    console.error('[HoursReport] Admin/Office section failed to build (team sections above are unaffected)', e);
    textLines.push(SEP_THIN);
    textLines.push('  ADMIN/OFFICE SECTION FAILED TO LOAD: ' + ((e && e.message) || String(e)));
  }

  textLines.push('');
  if (empsSeen === 0) {
    textLines.push('No employees found.');
  } else {
    textLines.push(SEP_HEAVY);
    textLines.push('  TOTAL · ' + _hrDecimalHoursText(grandHours) + ' · ' + empsSeen + ' employee' + (empsSeen === 1 ? '' : 's'));
    textLines.push(SEP_HEAVY);
  }

  return {
    text: textLines.join('\\n'),
    csv: csvRows.join('\\n') + '\\n',
    filename: 'hours-all-staff-' + fnameWeek + '.csv',
    weekLabel: weekLabel,
    grandHours: grandHours,
    empsSeen: empsSeen
  };
}"""

NEW = """// Payroll report simplification: splits an employee's name into
// {first, last}, preferring real first_name/last_name fields if a
// future caller ever supplies them (getUnifiedRoster's rows don't
// today -- EMPLOYEE_ROSTER is empty, every row comes from the facade,
// which collapses to a single `name` string by the time it gets here)
// and otherwise falling back to the SAME "first token is the first
// name, everything after is the last name" split already used
// elsewhere in this codebase (e.g. the staff-edit form's own
// first_name/last_name fallback) -- never invented fresh here.
function _hrSplitName(emp) {
  var fn = (emp && emp.first_name) ? String(emp.first_name).trim() : '';
  var ln = (emp && emp.last_name) ? String(emp.last_name).trim() : '';
  if (fn || ln) return { first: fn, last: ln };
  var full = String((emp && emp.name) || (emp && emp.id) || '').trim();
  if (!full) return { first: '', last: '' };
  var parts = full.split(/\\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

// Accent-insensitive, case-insensitive sort key. '' stays '' (blank
// last/first names are a normal, expected case here, never a crash).
function _hrSortNormalize(s) {
  s = String(s || '');
  try { s = s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); } catch (e) {}
  return s.toLowerCase();
}

// "Last, First" for display -- just the name, no comma, when there's
// no last name at all (never ", Bob" or "Bob,").
function _hrDisplayName(emp) {
  var n = _hrSplitName(emp);
  if (n.last) return n.last + ', ' + n.first;
  return n.first || (emp && emp.name) || (emp && emp.id) || '';
}

// Alphabetical by last name, case-insensitive, ignoring accents; ties
// broken by first name. An employee with NO last name sorts by their
// first name's own letter, but AFTER every real last name sharing that
// same letter (e.g. a bare "Bob" among the B's sorts after "Baker,
// Jane" but before "Carter, Sam") -- never crashes on either field
// being blank.
function _hrCompareByLastName(a, b) {
  var an = _hrSplitName(a.emp), bn = _hrSplitName(b.emp);
  var aLast = _hrSortNormalize(an.last), bLast = _hrSortNormalize(bn.last);
  var aFirst = _hrSortNormalize(an.first), bFirst = _hrSortNormalize(bn.first);
  var aHas = !!aLast, bHas = !!bLast;
  if (aHas && bHas) {
    if (aLast !== bLast) return aLast < bLast ? -1 : 1;
    return aFirst < bFirst ? -1 : (aFirst > bFirst ? 1 : 0);
  }
  if (!aHas && !bHas) {
    return aFirst < bFirst ? -1 : (aFirst > bFirst ? 1 : 0);
  }
  var aLetter = aHas ? aLast.charAt(0) : aFirst.charAt(0);
  var bLetter = bHas ? bLast.charAt(0) : bFirst.charAt(0);
  if (aLetter !== bLetter) return aLetter < bLetter ? -1 : 1;
  return aHas ? -1 : 1; // same letter group -- the blank-last one goes last
}

// Actual text/CSV builder -- shared by both the fast path (current
// week, reused weekHours) and slow path (freshly computed range) in
// _buildHoursReportForDates, since both normalize to the exact same
// { days, starts, ends, lunch, total } shape sized to dates.length.
//
// Payroll report simplification (Tom's request): two columns only,
// name and hours -- no rates, dollars, times, lunch, team, or notes
// anywhere in this report. Per-employee hours now come from
// resolveEmployeeDayHours -- the EXACT function the Hours tab's own
// renderHoursTable calls -- instead of a hand-rolled duplicate, so this
// report's number can never diverge from what the Hours tab shows for
// the same employee/range. Every employee with a real team on any day
// in range (field) or an hours override on file (Admin/Office,
// salaried Admin/Office correctly excluded, same as the Hours tab)
// gets ONE row if their total is > 0h; 0h employees are left out
// entirely, same as before.
function _buildHoursReportFromData(dates, weekHoursData, teams, empHoursMapData) {
  empHoursMapData = empHoursMapData || {};
  var firstDate = new Date(dates[0] + 'T00:00:00');
  var lastDate = new Date(dates[dates.length - 1] + 'T00:00:00');
  var weekLabel = firstDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + '–' + lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  var fnameWeek = dates[0] + '_to_' + dates[dates.length - 1];

  var SEP_HEAVY = '═'.repeat(43);

  var rows = []; // { emp, hours } -- one per employee with hours > 0

  // Field/team employees -- no more per-team grouping (PR #186's old
  // "appears once per team touched" bug class can't recur at all once
  // there's no team-grouped display left to duplicate into). Every
  // employee with a team on at least one day in range is checked once;
  // resolveEmployeeDayHours resolves each day's REAL team internally.
  var fieldEmployees = getUnifiedRoster(dates[0]).filter(function (e) {
    return e.work_type !== 'admin' && dates.some(function (dk) { return !!getEmployeeTeam(e.id, dk); });
  });
  fieldEmployees.forEach(function (emp) {
    var empWeekHours = 0;
    dates.forEach(function (dk, dayIdx) {
      var d = new Date(dk + 'T00:00:00');
      var rd = resolveEmployeeDayHours(emp.id, d, dayIdx, weekHoursData, empHoursMapData);
      if (!rd.isOff) empWeekHours += rd.hours;
    });
    if (empWeekHours > 0) rows.push({ emp: emp, hours: empWeekHours });
  });

  // Admin / Office (migration 113) -- own try/catch so one bad admin
  // row can't blank the whole report; every field employee above has
  // already been resolved successfully by this point. No team-
  // aggregate GPS data read at all here -- getEmpHours per day only,
  // exactly like the Hours tab's own Admin/Office group. Salaried
  // Admin/Office never has hours cells to read at all, same rule the
  // Hours tab itself applies -- correctly never produces a row here.
  try {
    var adminEmployees = getUnifiedRoster(dates[0]).filter(function (e) { return e.work_type === 'admin'; });
    adminEmployees.forEach(function (emp) {
      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) return;
      var empWeekHours = 0;
      dates.forEach(function (dk) {
        if (_employeeExcludedAsOf(emp, dk)) return;
        if (_adminEmpDayOff(emp.id, dk)) return;
        var override = getEmpHours(emp.id, dk);
        if (!override) return;
        empWeekHours += override.hours || 0;
      });
      if (empWeekHours > 0) rows.push({ emp: emp, hours: empWeekHours });
    });
  } catch (e) {
    console.error('[HoursReport] Admin/Office section failed to build (field employees above are unaffected)', e);
  }

  rows.sort(_hrCompareByLastName);

  var grandHours = 0;
  rows.forEach(function (r) { grandHours += r.hours; });

  var textLines = [];
  textLines.push(SEP_HEAVY);
  textLines.push('  HOURS REPORT');
  var _wBiz = (window.PentaTenant && window.PentaTenant.name && window.PentaTenant.name()) || '';
  textLines.push('  ' + weekLabel + (_wBiz ? ' · ' + _wBiz : ''));
  textLines.push(SEP_HEAVY);
  textLines.push('');

  var csvRows = [];
  csvRows.push('Name,Hours');

  if (rows.length === 0) {
    textLines.push('No employees found.');
  } else {
    var maxNameLen = 0;
    rows.forEach(function (r) { maxNameLen = Math.max(maxNameLen, _hrDisplayName(r.emp).length); });
    rows.forEach(function (r) {
      var name = _hrDisplayName(r.emp);
      textLines.push('  ' + name.padEnd(maxNameLen + 2) + r.hours.toFixed(2));
      csvRows.push(_hrCsvField(name) + ',' + r.hours.toFixed(2));
    });
    textLines.push('');
    textLines.push(SEP_HEAVY);
    textLines.push('  Total hours: ' + grandHours.toFixed(2));
    textLines.push(SEP_HEAVY);
  }

  return {
    text: textLines.join('\\n'),
    csv: csvRows.join('\\n') + '\\n',
    filename: 'hours-all-staff-' + fnameWeek + '.csv',
    weekLabel: weekLabel,
    grandHours: grandHours,
    empsSeen: rows.length
  };
}"""

EDITS = [("Payroll report simplification: Name+Hours only, sorted by last name, resolveEmployeeDayHours as single source of truth", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
