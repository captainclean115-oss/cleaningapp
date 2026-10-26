#!/usr/bin/env python3
"""Payroll cost card bug fix, step 3: renderPayrollCostCard.

- Total hours now reads result.totalHours (field-only, never excludes
  anyone for lacking a rate -- see step 1).
- New visible mismatch check: compares against window._hrsLastGrandTotal
  (captured synchronously, before the settings await, so a fast week-nav
  click can't compare against a later week's number) and shows "Hours
  total does not match the Hours table" in red if they ever disagree.
- New always-visible breakdown: "Hours with a pay rate", "Hours with no
  pay rate (N employees)", "Salaried (not included in pay): names",
  an hourly-Admin/Office disclosure when applicable, and the one-line
  "Wages and taxes cover employees with a pay rate only." disclosure.
- The collapsible per-employee detail (default collapsed, unchanged)
  keeps the named missing-rate sub-list -- relabeled since they're no
  longer "excluded", just unpaid -- and drops the now-redundant
  Salaried sub-list (that's in the always-visible summary now).
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD = """async function renderPayrollCostCard(days, weekHoursData, empHoursMapData) {
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
}"""

NEW = """async function renderPayrollCostCard(days, weekHoursData, empHoursMapData) {
  var el = document.getElementById('payroll-cost-card');
  if (!el) return;
  _payrollCardLastArgs = { days: days, weekHoursData: weekHoursData, empHoursMapData: empHoursMapData };
  // Captured now, synchronously, BEFORE the settings await below -- so
  // a fast week-navigation click in the meantime can't make this
  // compare against a later week's Hours-table total than the one
  // this exact render pass is actually using.
  var expectedGrandTotal = window._hrsLastGrandTotal;
  try {
    var settings = await _getPayrollSettings();
    var result = _computeWeekPayroll(days, weekHoursData, empHoursMapData, settings);
    var taxPct = _employerTaxPct(settings);
    var taxCents = taxPct != null ? Math.round(result.totalGrossCents * taxPct / 100) : null;
    var totalCostCents = result.totalGrossCents + (taxCents || 0);

    // Visible check (not a silent assumption): compare against the
    // ACTUAL number the Hours table just rendered, not a second
    // computation of this same formula, which could never disagree
    // with itself. A tiny epsilon absorbs floating-point noise only.
    var mismatch = (typeof expectedGrandTotal === 'number') && Math.abs(expectedGrandTotal - result.totalHours) > 0.005;

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
        + (rows.length ? rows.map(function (r) {
          return '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px">'
            + '<span>' + r.name + '</span>'
            + '<span style="color:var(--muted)">' + r.hours.toFixed(2) + 'h</span>'
            + '<span style="font-weight:600">' + _centsToDollarsStr(r.grossCents) + '</span>'
            + '</div>';
        }).join('') : '<div style="font-size:12px;color:var(--muted)">No employees with a pay rate have hours this week.</div>')
        + (result.missingRate.length ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--red);font-size:11px;font-weight:700">No pay rate on file (hours counted above, not paid)</div>'
          + result.missingRate.map(function (r) { return '<div style="font-size:12px;color:var(--red)">' + r.name + ' -- ' + r.hours.toFixed(2) + 'h</div>'; }).join('') : '')
        + '</div>';
    }

    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">'
      + '<div style="font-size:13px;font-weight:700">Payroll cost this week</div>'
      + '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Estimate, based on hours so far</div>'
      + '</div>'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:var(--muted)">Total hours</span><span style="font-weight:600">' + result.totalHours.toFixed(2) + 'h</span></div>'
      + (mismatch ? '<div style="margin:2px 0 4px;font-size:11px;font-weight:700;color:var(--red)">Hours total does not match the Hours table</div>' : '')
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:var(--muted)">Gross wages</span><span style="font-weight:600">' + _centsToDollarsStr(result.totalGrossCents) + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:var(--muted)">Employer taxes &amp; costs' + (taxPct != null ? ' (' + taxPct.toFixed(2) + '%)' : '') + '</span><span style="font-weight:600">' + (taxPct != null ? _centsToDollarsStr(taxCents) : 'not configured') + '</span></div>'
      + '<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span>Total cost</span><span>' + _centsToDollarsStr(totalCostCents) + '</span></div>'
      + '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:12px;line-height:1.6">'
      + '<div><span style="color:var(--muted)">Hours with a pay rate:</span> <span style="font-weight:600">' + result.hoursWithRate.toFixed(2) + 'h</span></div>'
      + '<div><span style="color:var(--muted)">Hours with no pay rate:</span> <span style="font-weight:600">' + result.hoursWithoutRate.toFixed(2) + 'h</span> <span style="color:var(--muted)">(' + result.missingRate.length + ' employee' + (result.missingRate.length === 1 ? '' : 's') + ')</span></div>'
      + (result.salaried.length ? '<div><span style="color:var(--muted)">Salaried (not included in pay):</span> ' + result.salaried.map(function (r) { return r.name; }).join(', ') + '</div>' : '')
      + (result.hasHourlyAdmin ? '<div style="color:var(--amber)">Admin/Office hourly pay isn\\'t included here yet \\u2014 see the Admin/Office card above.</div>' : '')
      + '<div style="color:var(--muted);margin-top:4px">Wages and taxes cover employees with a pay rate only.</div>'
      + '</div>'
      + '<button type="button" onclick="togglePayrollCardExpanded()" style="margin-top:8px;width:100%;background:none;border:1px solid var(--border);color:var(--muted);font-family:\\'DM Sans\\',sans-serif;font-size:11px;font-weight:600;padding:6px;border-radius:8px;cursor:pointer">' + (_payrollCardExpanded ? 'Hide details' : 'Show per-employee breakdown') + '</button>'
      + detailHtml;
  } catch (e) {
    console.error('[payroll card] render failed', e);
    el.innerHTML = '<div style="color:var(--red);font-size:12px">Could not load payroll cost. Pull to refresh or try again.</div>';
  }
}"""

apply_edits([
    ("renderPayrollCostCard: breakdown lines, mismatch check, hourly-admin disclosure", OLD, NEW),
])
