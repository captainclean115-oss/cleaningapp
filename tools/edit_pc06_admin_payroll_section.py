#!/usr/bin/env python3
"""Payroll cost tally feature. New Admin section, same pattern as the
existing Phone & SMS / Fleet Tracking sections (a titled admin-sec,
a button opening a dynamically-built modal, a status line).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    <!-- Client Health Scoring. Config lives in
         businesses.business_settings->'client_health' (seeded by migration
         071), so this reads/writes that jsonb rather than a table. -->
    <div class="admin-sec" id="admin-client-health-sec">"""

NEW = """    <!-- Payroll cost tally feature (migrations 117/118). Employer tax
         rates + overtime toggle. RLS (business_payroll_settings) is
         owner/admin/manager/dispatcher -- same manager-tier convention
         as every other table this app gates this way; employees can
         never read a row of it, not even their own business's. -->
    <div class="admin-sec" id="admin-payroll-sec">
      <div style="padding:12px 14px 8px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.60);text-transform:uppercase;letter-spacing:0.08em">Payroll</div>
      <div class="admin-row" style="gap:8px">
        <button onclick="openPayrollSettingsModal()" style="flex:1;background:rgba(251,191,36,0.18);border:1px solid rgba(251,191,36,0.45);color:#fde68a;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;padding:10px 12px;border-radius:10px;cursor:pointer">💰 Configure payroll settings</button>
      </div>
      <div id="admin-payroll-status" style="padding:0 14px 12px;font-size:12px;color:rgba(255,255,255,0.6)"></div>
    </div>

    <!-- Client Health Scoring. Config lives in
         businesses.business_settings->'client_health' (seeded by migration
         071), so this reads/writes that jsonb rather than a table. -->
    <div class="admin-sec" id="admin-client-health-sec">"""

EDITS = [("Admin panel: new Payroll section", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
