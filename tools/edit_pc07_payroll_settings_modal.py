#!/usr/bin/env python3
"""Payroll cost tally feature. openPayrollSettingsModal()/
savePayrollSettings() -- same dynamic-modal pattern as
openGeotabIntegrationSettings(). Two separate reads/writes:
business_payroll_settings (tax rates + overtime, manager-only table) and
businesses.show_estimated_pay_to_employees (one boolean on a table
employees can already read, so the portal can check it too).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function openGeotabIntegrationSettings() {"""

NEW = """async function openPayrollSettingsModal() {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  var bid = window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current();
  if (!sb || !bid) { alert('Tenant not resolved -- refresh and try again.'); return; }
  var existing = null, showEstPay = false;
  try {
    var pr = await sb.from('business_payroll_settings')
      .select('social_security_pct, medicare_pct, federal_unemployment_pct, state_unemployment_pct, other_employer_costs_pct, overtime_enabled')
      .eq('business_id', bid).maybeSingle();
    if (pr.error && (pr.error.code === '42501' || /permission/i.test(pr.error.message || ''))) {
      alert('Only owners and managers can view or edit payroll settings.');
      return;
    }
    existing = pr.data || null;
    var br = await sb.from('businesses').select('show_estimated_pay_to_employees').eq('id', bid).maybeSingle();
    showEstPay = !!(br.data && br.data.show_estimated_pay_to_employees);
  } catch (e) {
    alert('Could not load payroll settings: ' + (e.message || e));
    return;
  }
  var pctField = function (id, label, value) {
    return '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">' + label + ' %</div>'
      + '<input type="text" inputmode="decimal" id="' + id + '" value="' + (value != null ? value : '') + '" placeholder="not set" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:ui-monospace,monospace;font-size:13px;padding:10px 12px;border-radius:8px;margin-bottom:14px;outline:none">';
  };
  var overlay = document.createElement('div');
  overlay.id = 'payroll-settings-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:900;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = ''
    + '<div style="background:var(--surface);width:100%;max-width:540px;max-height:90vh;overflow-y:auto;border-radius:14px;border:1px solid var(--border2);padding:22px">'
    +   '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    +     '<div style="font-size:17px;font-weight:700">💰 Payroll Settings</div>'
    +     '<button type="button" onclick="document.getElementById(\\'payroll-settings-overlay\\').remove()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);width:30px;height:30px;border-radius:50%;font-size:17px;cursor:pointer">×</button>'
    +   '</div>'
    +   '<div style="background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.35);border-radius:10px;padding:11px 13px;margin-bottom:14px;font-size:12px;color:#fde68a;line-height:1.5">'
    +     'Leave a field blank until you know the real number -- nothing is estimated for employer taxes until every field below is filled in. The Payroll cost card on the Hours tab will show gross wages either way, just without an employer-tax line until then.'
    +   '</div>'
    + pctField('pr-ss', 'Social Security', existing && existing.social_security_pct)
    + pctField('pr-medicare', 'Medicare', existing && existing.medicare_pct)
    + pctField('pr-futa', 'Federal unemployment (FUTA)', existing && existing.federal_unemployment_pct)
    + pctField('pr-suta', 'State unemployment (SUTA)', existing && existing.state_unemployment_pct)
    + pctField('pr-other', 'Other employer costs', existing && existing.other_employer_costs_pct)
    + '<div id="pr-total-line" style="font-size:12px;color:var(--muted);margin-bottom:16px"></div>'
    + '<label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;cursor:pointer">'
    +   '<input type="checkbox" id="pr-overtime" ' + (existing && existing.overtime_enabled ? 'checked' : '') + '>'
    +   'Overtime: pay 1.5x for hours over 40 in the viewed Mon-Fri week'
    + '</label>'
    + '<div style="font-size:11px;color:var(--muted);margin:-8px 0 14px 26px;line-height:1.4">This is within the 5 days the Hours tab shows, not a true Monday-Sunday pay week -- this app does not track Saturday/Sunday hours anywhere yet. If anyone also works a weekend, her real weekly total (and real overtime) would be higher than what this shows.</div>'
    + '<label style="display:flex;align-items:center;gap:8px;margin-bottom:18px;font-size:13px;cursor:pointer">'
    +   '<input type="checkbox" id="pr-show-estimate" ' + (showEstPay ? 'checked' : '') + '>'
    +   'Show estimated pay to employees (off by default)'
    + '</label>'
    + '<div style="font-size:11px;color:var(--muted);margin:-10px 0 14px 26px;line-height:1.4">When on, each employee sees her own estimated gross pay (before taxes) for the week on her own Hours screen. She never sees the rate, employer taxes, or anyone else\\'s pay.</div>'
    + '<div style="display:flex;gap:8px">'
    +   '<button type="button" onclick="document.getElementById(\\'payroll-settings-overlay\\').remove()" style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:14px;font-weight:600;padding:11px;border-radius:10px;cursor:pointer">Cancel</button>'
    +   '<button type="button" onclick="savePayrollSettings()" style="flex:2;background:#fbbf24;border:none;color:#0a0a0a;font-family:\\'DM Sans\\',sans-serif;font-size:14px;font-weight:700;padding:11px;border-radius:10px;cursor:pointer">Save</button>'
    + '</div>'
    + '<div id="pr-save-status" style="font-size:12px;color:var(--muted);min-height:18px;margin-top:10px"></div>'
    + '</div>';
  document.body.appendChild(overlay);

  function recomputeTotalLine() {
    var ids = ['pr-ss', 'pr-medicare', 'pr-futa', 'pr-suta', 'pr-other'];
    var vals = ids.map(function (id) { var v = document.getElementById(id).value.trim(); return v === '' ? null : parseFloat(v); });
    var lineEl = document.getElementById('pr-total-line');
    if (vals.some(function (v) { return v == null || isNaN(v); })) { lineEl.textContent = 'Total employer tax %: not fully configured yet'; return; }
    var total = vals.reduce(function (s, v) { return s + v; }, 0);
    lineEl.innerHTML = '<strong>Total employer tax %: ' + total.toFixed(3) + '%</strong>';
  }
  ['pr-ss', 'pr-medicare', 'pr-futa', 'pr-suta', 'pr-other'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', recomputeTotalLine);
  });
  recomputeTotalLine();
}

async function savePayrollSettings() {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  var bid = window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current();
  var statusEl = document.getElementById('pr-save-status');
  if (!sb || !bid) { if (statusEl) statusEl.textContent = 'Not connected -- refresh and try again.'; return; }

  function pctVal(id) {
    var v = (document.getElementById(id).value || '').trim();
    if (v === '') return null;
    var n = parseFloat(v);
    if (isNaN(n) || n < 0 || n > 100) throw new Error('Enter a percent between 0 and 100 (or leave blank), e.g. 6.2, not ' + v);
    return n;
  }

  var currentUserId = null;
  try { var ures = await sb.auth.getUser(); currentUserId = ures && ures.data && ures.data.user && ures.data.user.id; } catch (e) {}

  var payload;
  try {
    payload = {
      business_id: bid,
      social_security_pct: pctVal('pr-ss'),
      medicare_pct: pctVal('pr-medicare'),
      federal_unemployment_pct: pctVal('pr-futa'),
      state_unemployment_pct: pctVal('pr-suta'),
      other_employer_costs_pct: pctVal('pr-other'),
      overtime_enabled: !!document.getElementById('pr-overtime').checked,
      updated_by: currentUserId
    };
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message; statusEl.style.color = 'var(--red)'; }
    return;
  }

  if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = 'var(--muted)'; }
  try {
    var res = await sb.from('business_payroll_settings').upsert(payload, { onConflict: 'business_id' });
    if (res.error) throw new Error(res.error.message);
    var showEst = !!document.getElementById('pr-show-estimate').checked;
    var bres = await sb.from('businesses').update({ show_estimated_pay_to_employees: showEst }).eq('id', bid);
    if (bres.error) throw new Error(bres.error.message);
    // Clear the cache so the Hours tab/payroll card pick up the new
    // settings on their next render instead of waiting out the 60s TTL.
    _payrollSettingsCache = null;
    if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = 'var(--green)'; }
    setTimeout(function () {
      var ov = document.getElementById('payroll-settings-overlay');
      if (ov) ov.remove();
      if (typeof renderPayrollCostCard === 'function' && _payrollCardLastArgs) {
        renderPayrollCostCard(_payrollCardLastArgs.days, _payrollCardLastArgs.weekHoursData, _payrollCardLastArgs.empHoursMapData);
      }
    }, 600);
  } catch (e) {
    if (statusEl) { statusEl.textContent = 'Could not save: ' + (e.message || e); statusEl.style.color = 'var(--red)'; }
  }
}

async function openGeotabIntegrationSettings() {"""

EDITS = [("Add openPayrollSettingsModal() + savePayrollSettings()", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
