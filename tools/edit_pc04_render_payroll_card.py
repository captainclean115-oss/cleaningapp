#!/usr/bin/env python3
"""Payroll cost tally feature. renderPayrollCostCard() -- the manager-
facing "Payroll cost this week" card on the Hours tab. Reads from the
SAME weekHoursData/empHoursMapData the Hours table itself just rendered
from (via the shared _computeWeekPayroll), plus business_payroll_settings
for employer tax rates and the overtime toggle. Owner/manager-facing
only (this whole section of the app -- #hours-section -- is already
manager-only, no new gating needed).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function _updatePublishIndicator(weekKey, info) {"""

NEW = """var _payrollCardSort = 'name'; // 'name' | 'hours' | 'gross'
var _payrollCardExpanded = false;
var _payrollCardLastArgs = null; // { days, weekHoursData, empHoursMapData } -- so sort/expand toggles can re-render without recomputing

function _centsToDollarsStr(cents) {
  if (cents == null) return '$0.00';
  var neg = cents < 0;
  var abs = Math.abs(Math.round(cents));
  var s = (abs / 100).toFixed(2);
  return (neg ? '-$' : '$') + s;
}

function togglePayrollCardExpanded() {
  _payrollCardExpanded = !_payrollCardExpanded;
  if (_payrollCardLastArgs) renderPayrollCostCard(_payrollCardLastArgs.days, _payrollCardLastArgs.weekHoursData, _payrollCardLastArgs.empHoursMapData);
}
function setPayrollCardSort(mode) {
  _payrollCardSort = mode;
  if (_payrollCardLastArgs) renderPayrollCostCard(_payrollCardLastArgs.days, _payrollCardLastArgs.weekHoursData, _payrollCardLastArgs.empHoursMapData);
}

async function renderPayrollCostCard(days, weekHoursData, empHoursMapData) {
  var el = document.getElementById('payroll-cost-card');
  if (!el) return;
  _payrollCardLastArgs = { days: days, weekHoursData: weekHoursData, empHoursMapData: empHoursMapData };
  try {
    var settings = await _getPayrollSettings();
    var result = _computeWeekPayroll(days, weekHoursData, empHoursMapData, settings);
    var taxPct = _employerTaxPct(settings);
    var taxCents = taxPct != null ? Math.round(result.totalGrossCents * taxPct / 100) : null;
    var totalCostCents = result.totalGrossCents + (taxCents || 0);

    var rows = result.included.slice();
    rows.sort(function (a, b) {
      if (_payrollCardSort === 'hours') return b.hours - a.hours;
      if (_payrollCardSort === 'gross') return (b.grossCents || 0) - (a.grossCents || 0);
      return (a.name || '').localeCompare(b.name || '');
    });

    var detailHtml = '';
    if (_payrollCardExpanded) {
      detailHtml = '<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">'
        + '<div style="display:flex;gap:10px;font-size:11px;color:var(--muted);margin-bottom:6px">'
        + '<span>Sort:</span>'
        + '<a href="#" onclick="setPayrollCardSort(\\'name\\');return false" style="color:' + (_payrollCardSort === 'name' ? 'var(--accent)' : 'var(--muted)') + '">Name</a>'
        + '<a href="#" onclick="setPayrollCardSort(\\'hours\\');return false" style="color:' + (_payrollCardSort === 'hours' ? 'var(--accent)' : 'var(--muted)') + '">Hours</a>'
        + '<a href="#" onclick="setPayrollCardSort(\\'gross\\');return false" style="color:' + (_payrollCardSort === 'gross' ? 'var(--accent)' : 'var(--muted)') + '">Gross</a>'
        + '</div>'
        + rows.map(function (r) {
          return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px">'
            + '<span>' + r.name + '</span>'
            + '<span style="color:var(--muted)">' + r.hours.toFixed(2) + 'h</span>'
            + '<span style="font-weight:600">' + _centsToDollarsStr(r.grossCents) + '</span>'
            + '</div>';
        }).join('')
        + (result.missingRate.length ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--red);font-size:11px;font-weight:700">Missing pay rate (excluded)</div>'
          + result.missingRate.map(function (r) { return '<div style="font-size:12px;color:var(--red)">' + r.name + ' -- ' + r.hours.toFixed(2) + 'h</div>'; }).join('') : '')
        + (result.salaried.length ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--muted);font-size:11px;font-weight:700">Salaried (not included)</div>'
          + result.salaried.map(function (r) { return '<div style="font-size:12px;color:var(--muted)">' + r.name + '</div>'; }).join('') : '')
        + '</div>';
    }

    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">'
      + '<div style="font-size:13px;font-weight:700">Payroll cost this week</div>'
      + '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Estimate, based on hours so far</div>'
      + '</div>'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:var(--muted)">Total hours</span><span style="font-weight:600">' + result.totalHours.toFixed(2) + 'h</span></div>'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:var(--muted)">Gross wages</span><span style="font-weight:600">' + _centsToDollarsStr(result.totalGrossCents) + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:var(--muted)">Employer taxes &amp; costs' + (taxPct != null ? ' (' + taxPct.toFixed(2) + '%)' : '') + '</span><span style="font-weight:600">' + (taxPct != null ? _centsToDollarsStr(taxCents) : 'not configured') + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span>Total cost</span><span>' + _centsToDollarsStr(totalCostCents) + '</span></div>'
      + (result.missingRate.length ? '<div style="margin-top:6px;font-size:11px;color:var(--red)">' + result.missingRate.length + ' employee' + (result.missingRate.length === 1 ? '' : 's') + ' with no pay rate on file, excluded from this total.</div>' : '')
      + '<button type="button" onclick="togglePayrollCardExpanded()" style="margin-top:8px;width:100%;background:none;border:1px solid var(--border);color:var(--muted);font-family:\\'DM Sans\\',sans-serif;font-size:11px;font-weight:600;padding:6px;border-radius:8px;cursor:pointer">' + (_payrollCardExpanded ? 'Hide details' : 'Show per-employee breakdown') + '</button>'
      + detailHtml;
  } catch (e) {
    console.error('[payroll card] render failed', e);
    el.innerHTML = '<div style="color:var(--red);font-size:12px">Could not load payroll cost. Pull to refresh or try again.</div>';
  }
}

function _updatePublishIndicator(weekKey, info) {"""

EDITS = [("Add renderPayrollCostCard() and its sort/expand helpers", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
