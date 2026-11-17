#!/usr/bin/env python3
"""Hire-transfer-missing-fields fix -- PART 4. Adds the 3 genuinely-new
fields (migration 124) to the Staff edit form's HTML: a Reliable
Transportation yes/no/not-set dropdown (three-way, not a checkbox --
"not asked" must stay distinguishable from an explicit "No"), a Prior
Employer text field, and an Earliest Start Date date picker.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """        <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Driver's License</div>
          <select id="staff-license" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none;appearance:none">
            <option value="">Select...</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
      </div>

      <!-- EXPERIENCE & AVAILABILITY -->"""

NEW = """        <div><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Driver's License</div>
          <select id="staff-license" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none;appearance:none">
            <option value="">Select...</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
      </div>
      <!-- Hire-transfer-missing-fields fix: from the job application's
           "reliable transportation" question (migration 124). Three-way
           select, not a checkbox -- "not asked" must stay distinguishable
           from an explicit "No". -->
      <div style="margin-bottom:14px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Reliable Transportation</div>
        <select id="staff-reliable-transport" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none;appearance:none">
          <option value="">Not set</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>

      <!-- EXPERIENCE & AVAILABILITY -->"""

OLD2 = """      <div style="margin-bottom:14px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Languages Spoken</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="English" id="staff-spoken-English" style="accent-color:var(--accent)"> English</label><label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="Spanish" id="staff-spoken-Spanish" style="accent-color:var(--accent)"> Spanish</label><label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="Portuguese" id="staff-spoken-Portuguese" style="accent-color:var(--accent)"> Portuguese</label><label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="Kriolu" id="staff-spoken-Kriolu" style="accent-color:var(--accent)"> Kriolu</label>
        </div>
      </div>

      <!-- EMERGENCY CONTACT -->"""

NEW2 = """      <div style="margin-bottom:14px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Languages Spoken</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="English" id="staff-spoken-English" style="accent-color:var(--accent)"> English</label><label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="Spanish" id="staff-spoken-Spanish" style="accent-color:var(--accent)"> Spanish</label><label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="Portuguese" id="staff-spoken-Portuguese" style="accent-color:var(--accent)"> Portuguese</label><label style="display:flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;padding:10px;cursor:pointer;font-size:13px"><input type="checkbox" value="Kriolu" id="staff-spoken-Kriolu" style="accent-color:var(--accent)"> Kriolu</label>
        </div>
      </div>
      <!-- Hire-transfer-missing-fields fix: from the job application
           (migration 124 -- prior_employer, earliest_start_date). -->
      <div style="margin-bottom:14px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Prior Employer</div>
        <input type="text" id="staff-prior-employer" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none">
      </div>
      <div style="margin-bottom:14px"><div style="font-size:12px;color:var(--muted);margin-bottom:6px">Earliest Start Date (from application)</div>
        <input type="date" id="staff-earliest-start" style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:9px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;padding:11px 14px;outline:none">
      </div>

      <!-- EMERGENCY CONTACT -->"""

EDITS = [
    ("Hire-transfer-missing-fields fix: add the Reliable Transportation dropdown", OLD, NEW),
    ("Hire-transfer-missing-fields fix: add Prior Employer + Earliest Start Date inputs", OLD2, NEW2),
]

if __name__ == "__main__":
    apply_edits(EDITS)
