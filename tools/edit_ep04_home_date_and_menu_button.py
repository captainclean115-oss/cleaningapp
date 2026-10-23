#!/usr/bin/env python3
"""Employee portal polish, step 4:
1. Home screen date: strip the tap-to-open-picker affordance (no
   onclick, no chevron, no button semantics) -- display-only, per spec.
2. Replace the visible "Log out" button in the portal header with a
   hamburger (three-bar) menu button that opens the new menu overlay
   (Account / About me / Language / Log out). Log out itself still
   works from inside that menu, with a confirm."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

DATE_OLD = '''        <div class="portal-team">
          <span class="team-badge" id="team-badge"></span>
          <button type="button" id="portal-date" onclick="empSchedOpenPicker()" style="-webkit-appearance:none !important;appearance:none !important;background:rgba(108,143,255,0.10) !important;border:1px solid rgba(108,143,255,0.30) !important;border-radius:999px !important;padding:5px 14px !important;color:var(--text) !important;font-family:inherit !important;font-size:13px !important;font-weight:600 !important;cursor:pointer !important;line-height:1.2 !important">Tap for date ▾</button>
        </div>'''

DATE_NEW = '''        <div class="portal-team">
          <span class="team-badge" id="team-badge"></span>
          <!-- Employee portal polish: display-only -- not tappable, no
               chevron, no onclick. A plain <span>, same visual pill as
               before, just no longer an interactive button. -->
          <span id="portal-date" style="display:inline-block;background:rgba(108,143,255,0.10);border:1px solid rgba(108,143,255,0.30);border-radius:999px;padding:5px 14px;color:var(--text);font-family:inherit;font-size:13px;font-weight:600;line-height:1.2"></span>
        </div>'''

MENU_BTN_OLD = '''      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        <!-- Share button removed 2026-04-19 — the Content tile in the icon
             grid is the single entry point now. -->
        <button onclick="logout()" style="background:var(--surface2);border:1px solid var(--border);color:var(--muted);font-size:12px;padding:6px 12px;border-radius:20px;cursor:pointer">
          <span id="logout-text">Log out</span>
        </button>
      </div>'''

MENU_BTN_NEW = '''      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        <!-- Share button removed 2026-04-19 — the Content tile in the icon
             grid is the single entry point now. Visible "Log out" button
             replaced by a hamburger menu (employee portal polish) -- Log
             out lives inside that menu now, reachable from every screen. -->
        <button type="button" onclick="openPortalMenu()" aria-label="Menu" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);width:44px;height:44px;min-width:44px;min-height:44px;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
      </div>'''

apply_edits([
    ("portal header: date display-only, no tap affordance", DATE_OLD, DATE_NEW),
    ("portal header: hamburger menu button replaces visible Log out button", MENU_BTN_OLD, MENU_BTN_NEW),
])
