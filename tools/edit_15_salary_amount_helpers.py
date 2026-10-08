#!/usr/bin/env python3
"""Salary amount/period follow-up -- shared parse/format helpers for the
new Staff modal "Salary amount ($)" field. One copy, reused by the
onblur reformatter AND the Save-time validation, so the two can never
drift on what counts as a valid amount.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "add salary amount parse/format/display helpers after isSalariedAdmin",
        """function isSalariedAdmin(emp) {
  if (!emp) return false;
  return emp.work_type === 'admin' && emp.pay_type === 'salary';
}""",
        """function isSalariedAdmin(emp) {
  if (!emp) return false;
  return emp.work_type === 'admin' && emp.pay_type === 'salary';
}

// Salary amount (migration 114 follow-up). Parses the Staff modal's
// text input (type=text/inputmode=decimal -- deliberately NOT
// type=number, so it can never be nudged by a scroll wheel or arrow
// key the way the Pay Rate field was). Accepts a leading $ and comma
// thousands separators, strips both, requires the rest to be a plain
// non-negative decimal number, and rounds to 2 decimals. Blank input
// is explicitly valid (ok:true, value:null) -- "Salaried with both
// amount and period blank" is an allowed not-set-yet state.
function _parseSalaryAmountInput(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') return { ok: true, value: null };
  var cleaned = s.replace(/^\\$/, '').replace(/,/g, '').trim();
  if (!/^\\d+(\\.\\d+)?$/.test(cleaned)) {
    return { ok: false, error: 'Salary amount must be a number (e.g. 13000 or 13,000.00) -- no letters or symbols other than a leading $ and commas.' };
  }
  var n = parseFloat(cleaned);
  if (isNaN(n)) return { ok: false, error: 'Salary amount must be a number.' };
  if (n < 0) return { ok: false, error: 'Salary amount cannot be negative.' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

// Nicely-formatted display string for the input itself, e.g.
// 13000 -> "13,000.00". null/blank -> ''.
function _fmtSalaryAmountInput(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

var SALARY_PERIOD_LABEL = { year: 'year', month: 'month', week: 'week' };

// One-line "Salaried - $13,000/month" summary, shared by the Staff
// list card, Staff subview card, and the Staff detail row -- never
// shown anywhere outside the Staff screen (Teams modal/Live/portal/
// Claire all show the plain "Salaried" label with no dollar figure,
// per spec). Falls back to plain "Salaried" when the amount/period
// haven't been entered yet (an explicitly allowed state).
function _fmtSalaryLine(emp) {
  if (!emp) return 'Salaried';
  var amt = emp.salary_amount;
  var per = emp.salary_period;
  if (amt == null || per == null || !SALARY_PERIOD_LABEL[per]) return 'Salaried';
  var n = parseFloat(amt);
  if (isNaN(n)) return 'Salaried';
  var whole = Math.round(n * 100) / 100;
  var display = (whole % 1 === 0)
    ? whole.toLocaleString('en-US')
    : whole.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return 'Salaried - $' + display + '/' + SALARY_PERIOD_LABEL[per];
}

// onblur handler for #staff-salary-amount -- reformats valid input to
// the "13,000.00" display form immediately so Tom sees the number was
// understood correctly, without waiting for Save. Invalid input is
// left as typed (so he can see and fix his own mistake) with a visible
// alert -- never silently cleared or silently accepted.
function _staffReformatSalaryAmountInput() {
  try {
    var el = document.getElementById('staff-salary-amount');
    if (!el) return;
    var parsed = _parseSalaryAmountInput(el.value);
    if (!parsed.ok) { alert(parsed.error); return; }
    el.value = parsed.value == null ? '' : _fmtSalaryAmountInput(parsed.value);
  } catch (e) {
    console.warn('[_staffReformatSalaryAmountInput] failed', e);
    alert('Could not check the salary amount field -- please re-check it before saving.');
  }
}""",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
