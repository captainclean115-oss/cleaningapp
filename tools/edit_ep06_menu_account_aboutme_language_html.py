#!/usr/bin/env python3
"""Employee portal polish, step 6: HTML for the hamburger menu overlay
and the Account / About me / Language screens. Inserted right before
</body> as siblings of every other full-screen overlay in this file."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

NEW_MARKUP = '''
<!-- EMPLOYEE PORTAL MENU (employee portal polish) — hamburger menu,
     replaces the old always-visible "Log out" button. Account / About
     me / Language / Log out. 44px+ tap targets throughout. -->
<div id="portal-menu-overlay" style="display:none;position:fixed;inset:0;z-index:9700;background:rgba(0,0,0,0.6)" onclick="if(event.target===this)closePortalMenu()">
  <div style="position:absolute;top:0;right:0;bottom:0;width:min(78vw,320px);background:var(--surface);border-left:1px solid var(--border2);display:flex;flex-direction:column;padding:calc(var(--safe-top) + 16px) 0 16px;box-shadow:-4px 0 24px rgba(0,0,0,0.3)">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:0 16px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
      <div style="font-size:16px;font-weight:700;color:var(--text)" id="portal-menu-title">Menu</div>
      <button type="button" onclick="closePortalMenu()" aria-label="Close" style="width:44px;height:44px;min-width:44px;min-height:44px;background:var(--surface2);border:1px solid var(--border);border-radius:50%;color:var(--text);font-size:18px;cursor:pointer">×</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:8px 0">
      <button type="button" onclick="closePortalMenu();openPortalAccount()" id="portal-menu-account" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;padding:14px 16px;min-height:44px;cursor:pointer">Account</button>
      <button type="button" onclick="closePortalMenu();openPortalAboutMe()" id="portal-menu-aboutme" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;padding:14px 16px;min-height:44px;cursor:pointer">About me</button>
      <button type="button" onclick="closePortalMenu();openPortalLanguage()" id="portal-menu-language" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;padding:14px 16px;min-height:44px;cursor:pointer">Language</button>
    </div>
    <div style="padding:8px 16px 0;border-top:1px solid var(--border);flex-shrink:0">
      <button type="button" onclick="portalMenuLogout()" id="portal-menu-logout" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--red);font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;padding:14px 16px;min-height:44px;cursor:pointer">Log out</button>
    </div>
  </div>
</div>

<!-- ACCOUNT -->
<div id="portal-account-overlay" style="display:none;position:fixed;inset:0;z-index:9750;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)closePortalAccount()">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;padding:20px;font-family:'DM Sans',sans-serif">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="font-size:17px;font-weight:700;color:var(--text)" id="portal-account-title">Account</div>
      <button type="button" onclick="closePortalAccount()" aria-label="Close" style="width:44px;height:44px;min-width:44px;background:var(--surface2);border:1px solid var(--border);border-radius:50%;color:var(--text);font-size:16px;cursor:pointer">×</button>
    </div>
    <div id="portal-account-body">Loading…</div>
  </div>
</div>

<!-- ABOUT ME -->
<div id="portal-aboutme-overlay" style="display:none;position:fixed;inset:0;z-index:9750;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)closePortalAboutMe()">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;max-width:420px;width:100%;max-height:85vh;overflow-y:auto;padding:20px;font-family:'DM Sans',sans-serif">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="font-size:17px;font-weight:700;color:var(--text)" id="portal-aboutme-title">About me</div>
      <button type="button" onclick="closePortalAboutMe()" aria-label="Close" style="width:44px;height:44px;min-width:44px;background:var(--surface2);border:1px solid var(--border);border-radius:50%;color:var(--text);font-size:16px;cursor:pointer">×</button>
    </div>
    <div id="portal-aboutme-body">Loading…</div>
  </div>
</div>

<!-- LANGUAGE -->
<div id="portal-language-overlay" style="display:none;position:fixed;inset:0;z-index:9750;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)closePortalLanguage()">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:16px;max-width:360px;width:100%;padding:20px;font-family:'DM Sans',sans-serif">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="font-size:17px;font-weight:700;color:var(--text)" id="portal-language-title">Language</div>
      <button type="button" onclick="closePortalLanguage()" aria-label="Close" style="width:44px;height:44px;min-width:44px;background:var(--surface2);border:1px solid var(--border);border-radius:50%;color:var(--text);font-size:16px;cursor:pointer">×</button>
    </div>
    <div id="portal-language-body"></div>
  </div>
</div>

</body>'''

apply_edits([
    ("insert portal menu / account / about-me / language overlay markup", "</body>", NEW_MARKUP),
])
