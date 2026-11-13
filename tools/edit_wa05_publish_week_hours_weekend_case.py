#!/usr/bin/env python3
"""Weekend-hours-assignment-only fix. publishWeekHours itself has no
day-of-week awareness -- the assignment-only rule lives entirely
inside resolveEmployeeDayHours (stubbed in this file, proven directly
in tests/hours-weekend-days.test.js). Adds one Saturday-dated fixture
(isOff:false, hours>0, same shape an explicit weekend assignment
resolves to) to prove the orchestration layer here publishes it
exactly like any weekday worked day -- no isUnconfirmed concept left
anywhere to skip it.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import _apply_edits as ae

ae.INDEX_HTML = os.path.join(os.path.dirname(__file__), "..", "tests", "publish-week-hours.test.js")

OLD_UUIDS = """const ELVIA_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINDA_UUID = 'aaaaaaaa-0000-4000-8000-000000000002';
const PAT_UUID = 'aaaaaaaa-0000-4000-8000-000000000003';
const ROSA_UUID = 'aaaaaaaa-0000-4000-8000-000000000004';

const ROSTER = [
  // Payroll cost tally feature: pay_rate added to exercise est_rate/
  // est_gross snapshotting. Pat (salaried) and Rosa (no rate on file)
  // deliberately left without one -- salaried never gets an estimate;
  // no-rate must publish with est_rate/est_gross both null, never 0.
  { id: 'elvia-legacy', uuid: ELVIA_UUID, name: 'Elvia', work_type: 'field', status: 'active', pay_rate: 20 },
  { id: 'linda-legacy', uuid: LINDA_UUID, name: 'Linda', work_type: 'admin', pay_type: 'hourly', status: 'active', pay_rate: 15 },
  { id: 'pat-legacy', uuid: PAT_UUID, name: 'Pat', work_type: 'admin', pay_type: 'salary', status: 'active' },
  // Rosa: terminated effective 2026-08-19 -- present for Mon/Tue (before),
  // excluded Wed/Thu/Fri (on/after), same isTerminatedAsOf rule getUnifiedRoster uses.
  { id: 'rosa-legacy', uuid: ROSA_UUID, name: 'Rosa', work_type: 'field', status: 'terminated', terminated_at: '2026-08-19' },
];"""

NEW_UUIDS = """const ELVIA_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINDA_UUID = 'aaaaaaaa-0000-4000-8000-000000000002';
const PAT_UUID = 'aaaaaaaa-0000-4000-8000-000000000003';
const ROSA_UUID = 'aaaaaaaa-0000-4000-8000-000000000004';
// Weekend-hours-assignment-only fix.
const WEEKEND_UUID = 'aaaaaaaa-0000-4000-8000-000000000006';

const ROSTER = [
  // Payroll cost tally feature: pay_rate added to exercise est_rate/
  // est_gross snapshotting. Pat (salaried) and Rosa (no rate on file)
  // deliberately left without one -- salaried never gets an estimate;
  // no-rate must publish with est_rate/est_gross both null, never 0.
  { id: 'elvia-legacy', uuid: ELVIA_UUID, name: 'Elvia', work_type: 'field', status: 'active', pay_rate: 20 },
  { id: 'linda-legacy', uuid: LINDA_UUID, name: 'Linda', work_type: 'admin', pay_type: 'hourly', status: 'active', pay_rate: 15 },
  { id: 'pat-legacy', uuid: PAT_UUID, name: 'Pat', work_type: 'admin', pay_type: 'salary', status: 'active' },
  // Rosa: terminated effective 2026-08-19 -- present for Mon/Tue (before),
  // excluded Wed/Thu/Fri (on/after), same isTerminatedAsOf rule getUnifiedRoster uses.
  { id: 'rosa-legacy', uuid: ROSA_UUID, name: 'Rosa', work_type: 'field', status: 'terminated', terminated_at: '2026-08-19' },
  // Weekend-hours-assignment-only fix: an employee explicitly assigned
  // a team on a Saturday -- her hours must publish exactly like a
  // weekday, since resolveEmployeeDayHours already resolved them.
  { id: 'weekend-legacy', uuid: WEEKEND_UUID, name: 'Weekend Worker', work_type: 'field', status: 'active', pay_rate: 25 },
];"""

OLD_RD = """  'rosa-legacy|2026-08-17': { dayTeam: 'B2', isOff: false, hours: 8, startDate: new Date('2026-08-17T13:00:00.000Z'), endDate: new Date('2026-08-17T21:00:00.000Z'), lunchMin: 0, isOverride: false },
  'rosa-legacy|2026-08-18': { dayTeam: 'B2', isOff: false, hours: 8, startDate: new Date('2026-08-18T13:00:00.000Z'), endDate: new Date('2026-08-18T21:00:00.000Z'), lunchMin: 0, isOverride: false },
};"""

NEW_RD = """  'rosa-legacy|2026-08-17': { dayTeam: 'B2', isOff: false, hours: 8, startDate: new Date('2026-08-17T13:00:00.000Z'), endDate: new Date('2026-08-17T21:00:00.000Z'), lunchMin: 0, isOverride: false },
  'rosa-legacy|2026-08-18': { dayTeam: 'B2', isOff: false, hours: 8, startDate: new Date('2026-08-18T13:00:00.000Z'), endDate: new Date('2026-08-18T21:00:00.000Z'), lunchMin: 0, isOverride: false },
  // Weekend-hours-assignment-only fix: Saturday 2026-08-22, explicitly
  // assigned (the shape resolveEmployeeDayHours resolves to once an
  // explicit daily_assignments entry exists for that date).
  'weekend-legacy|2026-08-22': { dayTeam: 'M2', isOff: false, hours: 4, startDate: null, endDate: null, lunchMin: 0, isOverride: false },
};"""

OLD_TAIL = """  console.log('\\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();"""

NEW_TAIL = """  // Weekend-hours-assignment-only fix: publishWeekHours has no
  // day-of-week logic of its own -- proving it treats an
  // already-resolved Saturday exactly like a weekday confirms there's
  // no leftover skip (isUnconfirmed or otherwise) gating weekend rows.
  {
    const satDate = new Date(2026, 7, 22); // Saturday
    const { sandbox: sandboxWk, upsertCalls: upsertCallsWk } = buildSandbox({});
    await sandboxWk.publishWeekHours([satDate], {}, {});
    const writtenWk = {};
    upsertCallsWk.forEach(function (c) { c.rows.forEach(function (r) { writtenWk[r.employee_id + '|' + r.work_date] = r; }); });
    const row = writtenWk[WEEKEND_UUID + '|2026-08-22'];
    check('an explicitly-assigned Saturday publishes with status worked, same as a weekday', row && row.status, 'worked');
    check('an explicitly-assigned Saturday publishes its hours in full (4h), no skip', row && row.hours, 4);
  }

  console.log('\\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();"""

EDITS = [
    ("Weekend-hours-assignment-only fix: add weekend-assigned employee to ROSTER", OLD_UUIDS, NEW_UUIDS),
    ("Weekend-hours-assignment-only fix: add weekend RD fixture", OLD_RD, NEW_RD),
    ("Weekend-hours-assignment-only fix: assert a Saturday publishes like a weekday", OLD_TAIL, NEW_TAIL),
]

if __name__ == "__main__":
    ae.apply_edits(EDITS)
