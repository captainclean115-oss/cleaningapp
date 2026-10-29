#!/usr/bin/env python3
"""Payroll cost tally feature. _renderPortalEstimatedPay() -- the
employee-facing "Estimated gross pay this week" line. Gated by
businesses.show_estimated_pay_to_employees (default OFF). Shows "so
far" whenever any day in the viewed week isn't published/in-progress
yet, matching the spec exactly: never implies a day's worth of pay that
hasn't actually been computed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function _renderPortalHoursUpdatedLabel(publishedAtIso) {
  var el = document.getElementById('portal-hours-updated');
  if (!el) return;
  if (!publishedAtIso) { el.textContent = ''; return; }
  try {
    var d = new Date(publishedAtIso);
    el.textContent = 'Updated ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { el.textContent = ''; }
}"""

NEW = """function _renderPortalHoursUpdatedLabel(publishedAtIso) {
  var el = document.getElementById('portal-hours-updated');
  if (!el) return;
  if (!publishedAtIso) { el.textContent = ''; return; }
  try {
    var d = new Date(publishedAtIso);
    el.textContent = 'Updated ' + d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { el.textContent = ''; }
}

// Payroll cost tally feature: employee-facing estimated gross pay line.
// Never shows the rate, employer taxes, or anyone else's pay -- only
// the one summed number, and only when the business has explicitly
// turned this on (default OFF). This function does its own small
// Supabase read (businesses.show_estimated_pay_to_employees) -- that
// table's SELECT policy already has no role restriction, so this is
// not a new attack surface, just reading a flag that was already
// readable.
async function _renderPortalEstimatedPay(estGrossCentsSoFar, anyDayIncomplete) {
  var el = document.getElementById('portal-estimated-pay');
  if (!el) return;
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    var bid = (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null;
    if (!sb || !bid) { el.innerHTML = ''; return; }
    var res = await sb.from('businesses').select('show_estimated_pay_to_employees').eq('id', bid).maybeSingle();
    var show = !!(res.data && res.data.show_estimated_pay_to_employees);
    if (!show) { el.innerHTML = ''; return; }
    var dollars = (Math.round(estGrossCentsSoFar) / 100).toFixed(2);
    el.innerHTML = '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">'
      + '<div style="font-size:13px;font-weight:600">Estimated gross pay this ' + (anyDayIncomplete ? 'week so far' : 'week') + ': $' + dollars + '</div>'
      + '<div style="font-size:11px;color:var(--muted);margin-top:2px">Estimate before taxes and deductions. Your actual paycheck may differ.</div>'
      + '</div>';
  } catch (e) {
    console.warn('[portal estimated pay] failed (non-fatal)', e);
    el.innerHTML = '';
  }
}"""

EDITS = [("Add _renderPortalEstimatedPay()", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
