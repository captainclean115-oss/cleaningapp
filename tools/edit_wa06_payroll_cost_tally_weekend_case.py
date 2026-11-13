#!/usr/bin/env python3
"""Weekend-hours-assignment-only fix. _computeWeekPayroll has no
day-of-week logic of its own either -- adds a Saturday-dated employee
(already-resolved isOff:false/hours shape, matching what an explicit
weekend assignment produces) to prove her hours and dollars are
included in full, with no isUnconfirmed-style exclusion left.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import _apply_edits as ae

ae.INDEX_HTML = os.path.join(os.path.dirname(__file__), "..", "tests", "payroll-cost-tally.test.js")

OLD_ROSTER = """  const ROSTER = [
    { id: 'elvia-legacy', uuid: ELVIA_UUID, name: 'Elvia', work_type: 'field', status: 'active', pay_rate: 20 },
    { id: 'linda-legacy', uuid: LINDA_UUID, name: 'Linda', work_type: 'admin', pay_type: 'hourly', status: 'active', pay_rate: 15 },
    { id: 'pat-legacy', uuid: PAT_UUID, name: 'Pat', work_type: 'admin', pay_type: 'salary', status: 'active', pay_rate: null },
    { id: 'rosa-legacy', uuid: ROSA_UUID, name: 'Rosa', work_type: 'field', status: 'terminated', terminated_at: '2026-08-19', pay_rate: 18 },
    { id: 'norate-legacy', uuid: NORATE_UUID, name: 'NoRate', work_type: 'field', status: 'active', pay_rate: null },
  ];"""

NEW_ROSTER = """  // Weekend-hours-assignment-only fix.
  const WEEKEND_UUID = 'aaaaaaaa-0000-4000-8000-000000000006';

  const ROSTER = [
    { id: 'elvia-legacy', uuid: ELVIA_UUID, name: 'Elvia', work_type: 'field', status: 'active', pay_rate: 20 },
    { id: 'linda-legacy', uuid: LINDA_UUID, name: 'Linda', work_type: 'admin', pay_type: 'hourly', status: 'active', pay_rate: 15 },
    { id: 'pat-legacy', uuid: PAT_UUID, name: 'Pat', work_type: 'admin', pay_type: 'salary', status: 'active', pay_rate: null },
    { id: 'rosa-legacy', uuid: ROSA_UUID, name: 'Rosa', work_type: 'field', status: 'terminated', terminated_at: '2026-08-19', pay_rate: 18 },
    { id: 'norate-legacy', uuid: NORATE_UUID, name: 'NoRate', work_type: 'field', status: 'active', pay_rate: null },
    // Weekend-hours-assignment-only fix: explicitly assigned a team on
    // a Saturday -- her dollars must count in full, same as a weekday.
    { id: 'weekend-legacy', uuid: WEEKEND_UUID, name: 'Weekend Worker', work_type: 'field', status: 'active', pay_rate: 25 },
  ];"""

OLD_DISPATCH = """      resolveEmployeeDayHours: function (empId, d, dayIdx) {
        const dateStr = dk(d);
        if (empId === 'elvia-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ELVIA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        if (empId === 'rosa-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ROSA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        if (empId === 'norate-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, NORATE_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        return { dayTeam: null, isOff: true, hours: 0, isOverride: false, startDate: null, endDate: null, lunchMin: 0 };
      },"""

NEW_DISPATCH = """      resolveEmployeeDayHours: function (empId, d, dayIdx) {
        const dateStr = dk(d);
        if (empId === 'elvia-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ELVIA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        if (empId === 'rosa-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, ROSA_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        if (empId === 'norate-legacy') return Object.assign({ startDate: null, endDate: null, lunchMin: 0 }, NORATE_RD[dateStr] || { dayTeam: null, isOff: true, hours: 0, isOverride: false });
        // Weekend-hours-assignment-only fix: Saturday 2026-08-22,
        // explicitly assigned (the shape resolveEmployeeDayHours
        // resolves to once an explicit daily_assignments entry exists).
        if (empId === 'weekend-legacy') return dateStr === '2026-08-22' ? { dayTeam: 'M2', isOff: false, hours: 4, isOverride: false, startDate: null, endDate: null, lunchMin: 0 } : { dayTeam: null, isOff: true, hours: 0, isOverride: false, startDate: null, endDate: null, lunchMin: 0 };
        return { dayTeam: null, isOff: true, hours: 0, isOverride: false, startDate: null, endDate: null, lunchMin: 0 };
      },"""

OLD_TAIL = """    check('payroll tally\\'s total hours equal hand-summed resolveEmployeeDayHours totals for the same fixture (field employees only, rated or not)', result.totalHours, manualTotal);
  }

  console.log('\\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();"""

NEW_TAIL = """    check('payroll tally\\'s total hours equal hand-summed resolveEmployeeDayHours totals for the same fixture (field employees only, rated or not)', result.totalHours, manualTotal);
  }

  // Weekend-hours-assignment-only fix: _computeWeekPayroll has no
  // day-of-week logic of its own -- an explicitly-assigned Saturday's
  // hours and dollars count in full, exactly like a weekday.
  {
    const sandbox2 = makeSandboxForWeek(false);
    const satDate = new Date(2026, 7, 22); // Saturday
    const result = withFrozenNow(sandbox2, function () {
      return sandbox2._computeWeekPayroll([satDate], {}, {}, { overtime_enabled: false });
    });
    const weekend = result.included.find(function (e) { return e.empId === WEEKEND_UUID; });
    check('an explicitly-assigned Saturday is included with full hours (4h)', weekend && weekend.hours, 4);
    check('an explicitly-assigned Saturday\\'s dollars are included in full (4 * $25)', weekend && weekend.grossCents, 4 * 25 * 100);
  }

  console.log('\\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();"""

EDITS = [
    ("Weekend-hours-assignment-only fix: add weekend-assigned employee to ROSTER", OLD_ROSTER, NEW_ROSTER),
    ("Weekend-hours-assignment-only fix: dispatch resolveEmployeeDayHours stub for the weekend employee", OLD_DISPATCH, NEW_DISPATCH),
    ("Weekend-hours-assignment-only fix: assert a Saturday's hours+dollars count in full", OLD_TAIL, NEW_TAIL),
]

if __name__ == "__main__":
    ae.apply_edits(EDITS)
