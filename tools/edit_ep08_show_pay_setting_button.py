#!/usr/bin/env python3
"""Employee portal polish, step 8: the owner-only "Show pay in About
me" toggle. No general "Settings" screen exists in this app today (the
existing 'settings' home tile is specifically MgrRewards' own Earn/
Catalog config, not a fit for this) -- added as its own small button
next to Bulk invite on the Staff screen, the natural home for an
employee-related admin control. The REAL enforcement is server-side
(set_show_pay_in_about_me itself refuses a non-owner caller) -- this
button stays visible to any manager-tier user, and its own handler
shows a plain refusal if she isn't the owner, rather than a confusing
half-hidden control."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

BUTTON_OLD = '''        <button onclick="openBulkInviteModal()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 12px;border-radius:20px;cursor:pointer">✉️ Bulk invite</button>'''

BUTTON_NEW = '''        <button onclick="openBulkInviteModal()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 12px;border-radius:20px;cursor:pointer">✉️ Bulk invite</button>
        <button onclick="openPayVisibilitySetting()" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;padding:7px 12px;border-radius:20px;cursor:pointer">⚙️ Pay in About me</button>'''

JS_FN = """
// Employee portal polish — owner-only toggle: whether About me shows
// pay at all. Real enforcement is server-side (set_show_pay_in_about_me
// itself refuses a non-owner caller) -- this button stays visible to
// any manager-tier user; a non-owner just gets a plain refusal here,
// same message the RPC itself would give.
async function openPayVisibilitySetting() {
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) { alert('Not connected — reload and try again.'); return; }
    var bid = (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null;
    var cur = true;
    try {
      var biz = bid ? await sb.from('businesses').select('business_settings').eq('id', bid).maybeSingle() : null;
      if (biz && biz.data && biz.data.business_settings && biz.data.business_settings.show_pay_in_about_me === false) cur = false;
    } catch (e) {}
    var next = !cur;
    if (!confirm((cur ? 'Pay is currently SHOWN' : 'Pay is currently HIDDEN') + ' in employees\\' About me screen.\\n\\n' + (next ? 'Turn it ON (show pay)?' : 'Turn it OFF (hide pay)?'))) return;
    var res = await sb.rpc('set_show_pay_in_about_me', { p_enabled: next });
    if (res.error) { alert('Could not change this setting: ' + res.error.message); return; }
    alert('Done — pay is now ' + (next ? 'shown' : 'hidden') + ' in About me.');
  } catch (e) {
    console.error('[pay visibility setting] failed', e);
    alert('Could not change this setting: ' + ((e && e.message) || String(e)));
  }
}
"""

apply_edits([
    ("Staff sheet header: add owner-only Pay-visibility setting button", BUTTON_OLD, BUTTON_NEW),
    ("add openPayVisibilitySetting()", "function portalGoHome() { showPortalTab('home'); }", "function portalGoHome() { showPortalTab('home'); }\n" + JS_FN),
])
