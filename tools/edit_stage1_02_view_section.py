#!/usr/bin/env python3
"""Stage 1 -- PART 2. Add the "Manager Access" section to the Staff
View tab's dynamic per-employee template, right after Penta Login
(related account controls living together), plus its async paint/wire
call in the same place the Penta Login section already gets wired.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_HTML = """      _showFixLogin
        ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
            <button type="button" id="fix-login-btn" data-action="fix-login" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="width:100%;padding:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Fix login</button>
            <div id="fix-login-panel" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="font-size:12px;margin-top:8px;display:none"></div>
          </div>`
        : ''
    ])}
"""

NEW_HTML = """      _showFixLogin
        ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
            <button type="button" id="fix-login-btn" data-action="fix-login" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="width:100%;padding:10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Fix login</button>
            <div id="fix-login-panel" data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="font-size:12px;margin-top:8px;display:none"></div>
          </div>`
        : ''
    ])}

    ${section('Manager Access', [
      `<div data-mgr-access-status data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="font-size:13px;color:var(--muted);margin-bottom:10px">Loading…</div>`,
      `<label data-mgr-access-toggle-wrap data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="display:none;align-items:center;justify-content:space-between;cursor:pointer;padding:8px 0">
        <span style="font-size:13px;font-weight:600">Give manager access</span>
        <input type="checkbox" data-mgr-access-toggle data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="width:20px;height:20px;accent-color:var(--accent)">
      </label>`,
      `<div data-mgr-access-permlink data-roster-id="${emp.legacy_roster_id||emp.id||emp.name}" style="margin-top:6px;font-size:12px;color:var(--muted);display:none">Full access by default — per-permission toggles are coming in the next update.</div>`
    ])}
"""

OLD_WIRE = """    if (_fixBt)  _fixBt.addEventListener('click',  function() { pentaFixLogin(_rid); });
    if (_chip && typeof pentaRenderInviteChip === 'function') pentaRenderInviteChip(_rid, _chip, _sendBt);
    if (typeof applyPermissions === 'function') applyPermissions();
  } catch (e) { console.warn('[Penta Login section] wiring failed', e); }"""

NEW_WIRE = """    if (_fixBt)  _fixBt.addEventListener('click',  function() { pentaFixLogin(_rid); });
    if (_chip && typeof pentaRenderInviteChip === 'function') pentaRenderInviteChip(_rid, _chip, _sendBt);
    if (typeof applyPermissions === 'function') applyPermissions();
  } catch (e) { console.warn('[Penta Login section] wiring failed', e); }

  // Stage 1: wire the Manager Access section (same roster-id-keyed
  // data-attribute lookup pattern as Penta Login above).
  try {
    var _ridMA = emp.legacy_roster_id || emp.id || emp.name;
    var _maStatus = document.querySelector('[data-mgr-access-status][data-roster-id="' + CSS.escape(_ridMA) + '"]');
    var _maToggleWrap = document.querySelector('[data-mgr-access-toggle-wrap][data-roster-id="' + CSS.escape(_ridMA) + '"]');
    var _maToggle = document.querySelector('[data-mgr-access-toggle][data-roster-id="' + CSS.escape(_ridMA) + '"]');
    var _maPermLink = document.querySelector('[data-mgr-access-permlink][data-roster-id="' + CSS.escape(_ridMA) + '"]');
    if (_maStatus) _renderManagerAccessSection(emp, { statusEl: _maStatus, toggleWrap: _maToggleWrap, toggleEl: _maToggle, permLinkEl: _maPermLink });
  } catch (e) { console.warn('[Manager Access section] wiring failed', e); }"""

EDITS = [
    ("Stage 1: add Manager Access HTML after Penta Login on the View tab", OLD_HTML, NEW_HTML),
    ("Stage 1: wire the Manager Access section on the View tab", OLD_WIRE, NEW_WIRE),
]

if __name__ == "__main__":
    apply_edits(EDITS)
