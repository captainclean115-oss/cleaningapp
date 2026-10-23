#!/usr/bin/env python3
"""Employee portal polish, step 7: the JS behind the hamburger menu,
Account, About me, and Language screens, plus the boot-time language
fallback chain (localStorage first -- safe, always available -- then a
best-effort, try/caught upgrade to her real preferred_language column
once migration 119 is applied; never touches the critical boot-time
employee-resolution query itself, so a not-yet-applied migration can
never break login)."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

BOOT_LANG_OLD = """  currentEmployee = emp;
  currentLang = appSelectedLang || emp.lang || 'en';"""

BOOT_LANG_NEW = """  currentEmployee = emp;
  // Employee portal polish: her own per-device choice (if any) wins
  // first -- synchronous, always available, never blocks boot. The
  // dead PIN-screen picker (appSelectedLang) and culture_tag-derived
  // default are the same fallback chain as before this change.
  currentLang = (function () {
    try { var saved = localStorage.getItem('penta_portal_lang'); if (saved) return saved; } catch (e) {}
    return appSelectedLang || emp.lang || 'en';
  })();
  // Best-effort upgrade to her REAL saved preferred_language column,
  // once migration 119 is applied -- fire-and-forget, never blocks
  // boot, and the .catch swallows "column does not exist" cleanly if
  // the migration hasn't shipped yet (never breaks login either way).
  try {
    var _sbLang = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (_sbLang && emp && emp.uuid) {
      _sbLang.from('employees').select('preferred_language').eq('id', emp.uuid).maybeSingle()
        .then(function (r) {
          if (r && r.data && r.data.preferred_language && r.data.preferred_language !== currentLang) {
            try { setPortalLang(r.data.preferred_language); } catch (e2) {}
          }
        })
        .catch(function () {});
    }
  } catch (e) {}"""

MENU_JS = """
// ═══════════════════════════════════════════════════════════════════════
// Employee portal polish — hamburger menu + Account / About me / Language
// ═══════════════════════════════════════════════════════════════════════
function openPortalMenu() {
  try {
    _renderPortalMenuTexts();
    var ov = document.getElementById('portal-menu-overlay');
    if (ov) ov.style.display = 'block';
  } catch (e) { console.error('[portal menu] open failed', e); alert('Could not open the menu.'); }
}
function closePortalMenu() {
  var ov = document.getElementById('portal-menu-overlay');
  if (ov) ov.style.display = 'none';
}
function _renderPortalMenuTexts() {
  try {
    var map = { 'portal-menu-title': 'menuTitle', 'portal-menu-account': 'menuAccount', 'portal-menu-aboutme': 'menuAboutMe', 'portal-menu-language': 'menuLanguage', 'portal-menu-logout': 'menuLogout' };
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) el.textContent = t(map[id]); });
  } catch (e) { console.error('[portal menu] text render failed', e); }
}
function portalMenuLogout() {
  try {
    if (!confirm(t('logoutConfirm'))) return;
    closePortalMenu();
    logout();
  } catch (e) { console.error('[portal menu] logout failed', e); alert('Could not log out. Try again.'); }
}

// ── ACCOUNT ──
var _portalAccountRow = null;
async function openPortalAccount() {
  var ov = document.getElementById('portal-account-overlay');
  var body = document.getElementById('portal-account-body');
  var titleEl = document.getElementById('portal-account-title');
  try { if (titleEl) titleEl.textContent = t('accountTitle'); } catch (e) {}
  if (ov) ov.style.display = 'flex';
  if (body) body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Loading…</div>';
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) throw new Error('Not connected');
    if (!currentEmployee || !currentEmployee.uuid) throw new Error('No employee record');
    // READ: her own row, every column -- already permitted by RLS
    // (employees_select's auth_user_id = auth.uid() branch), unchanged
    // by migration 119 (which only tightens UPDATE). Only the SAVE
    // below goes through the whitelist RPC.
    var res = await sb.from('employees')
      .select('phone, first_name, last_name, address, city, state, zip, emergency_contact_name, emergency_contact_phone')
      .eq('id', currentEmployee.uuid)
      .maybeSingle();
    if (res.error || !res.data) throw new Error((res.error && res.error.message) || 'No data');
    _portalAccountRow = res.data;
    renderPortalAccount();
  } catch (e) {
    console.error('[portal account] load failed', e);
    if (body) body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">' + _adminEsc(t('aboutMeNotAvailable')) + '</div>';
  }
}
function closePortalAccount() { var ov = document.getElementById('portal-account-overlay'); if (ov) ov.style.display = 'none'; }
function _portalAccountField(id, label, value) {
  return '<div style="margin-bottom:14px">'
    + '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">' + _adminEsc(label) + '</div>'
    + '<input type="text" id="' + id + '" value="' + _adminEsc(value || '') + '" style="width:100%;box-sizing:border-box;min-height:44px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:\\'DM Sans\\',sans-serif;font-size:15px">'
    + '</div>';
}
function renderPortalAccount() {
  try {
    var body = document.getElementById('portal-account-body');
    if (!body || !_portalAccountRow) return;
    var r = _portalAccountRow;
    var fullName = ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || '—';
    body.innerHTML = ''
      + '<div style="margin-bottom:14px">'
      +   '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">' + _adminEsc(t('accountNameLabel')) + '</div>'
      +   '<div style="font-size:15px;color:var(--text);padding:10px 0">' + _adminEsc(fullName) + '</div>'
      + '</div>'
      + '<div style="margin-bottom:10px">'
      +   '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">' + _adminEsc(t('accountPhoneLabel')) + '</div>'
      +   '<div style="font-size:15px;color:var(--text);padding:10px 0">' + _adminEsc(r.phone || '—') + '</div>'
      + '</div>'
      + '<div style="font-size:12px;color:var(--muted);margin-bottom:16px;padding:8px 10px;background:var(--surface2);border-radius:8px">' + _adminEsc(t('accountReadonlyNote')) + '</div>'
      + _portalAccountField('pa-address', t('accountAddress'), r.address)
      + _portalAccountField('pa-city', t('accountCity'), r.city)
      + _portalAccountField('pa-state', t('accountState'), r.state)
      + _portalAccountField('pa-zip', t('accountZip'), r.zip)
      + _portalAccountField('pa-ecname', t('accountEmergencyName'), r.emergency_contact_name)
      + _portalAccountField('pa-ecphone', t('accountEmergencyPhone'), r.emergency_contact_phone)
      + '<div id="portal-account-result" style="min-height:18px;font-size:13px;margin:10px 0"></div>'
      + '<button type="button" onclick="savePortalAccount()" style="width:100%;min-height:44px;background:var(--accent);border:none;color:#fff;font-family:\\'DM Sans\\',sans-serif;font-size:15px;font-weight:700;border-radius:10px;cursor:pointer">' + _adminEsc(t('accountSave')) + '</button>';
  } catch (e) { console.error('[portal account] render failed', e); }
}
async function savePortalAccount() {
  var resultEl = document.getElementById('portal-account-result');
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) throw new Error('Not connected — reload and try again.');
    var val = function (id) { var el = document.getElementById(id); return (el && el.value) ? el.value : null; };
    var res = await sb.rpc('update_my_employee_profile', {
      p_address: val('pa-address'),
      p_city: val('pa-city'),
      p_state: val('pa-state'),
      p_zip: val('pa-zip'),
      p_emergency_contact_name: val('pa-ecname'),
      p_emergency_contact_phone: val('pa-ecphone')
    });
    if (res.error) throw new Error(res.error.message || 'Save failed');
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--green)">' + _adminEsc(t('accountSaved')) + '</span>';
  } catch (e) {
    console.error('[portal account] save failed', e);
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--red)">' + _adminEsc(t('accountSaveFailed')) + ': ' + _adminEsc((e && e.message) || String(e)) + '</span>';
  }
}

// ── ABOUT ME ──
async function openPortalAboutMe() {
  var ov = document.getElementById('portal-aboutme-overlay');
  var body = document.getElementById('portal-aboutme-body');
  var titleEl = document.getElementById('portal-aboutme-title');
  try { if (titleEl) titleEl.textContent = t('aboutMeTitle'); } catch (e) {}
  if (ov) ov.style.display = 'flex';
  if (body) body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Loading…</div>';
  try {
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) throw new Error('Not connected');
    var res = await sb.rpc('get_my_about_me');
    if (res.error) throw new Error(res.error.message || 'Not available');
    renderPortalAboutMe(res.data);
  } catch (e) {
    console.error('[portal about-me] load failed', e);
    // Deploy safety: if the RPC/migration isn't live yet, this is the
    // ONLY thing that happens -- a plain message, never a blank page.
    if (body) body.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">' + _adminEsc(t('aboutMeNotAvailable')) + '</div>';
  }
}
function closePortalAboutMe() { var ov = document.getElementById('portal-aboutme-overlay'); if (ov) ov.style.display = 'none'; }
function _portalAboutMeRow(label, value) {
  return '<div style="display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)">'
    + '<div style="font-size:13px;color:var(--muted)">' + _adminEsc(label) + '</div>'
    + '<div style="font-size:14px;font-weight:600;color:var(--text);text-align:right">' + _adminEsc(value) + '</div>'
    + '</div>';
}
function renderPortalAboutMe(d) {
  try {
    var body = document.getElementById('portal-aboutme-body');
    if (!body || !d) return;
    var payRow = '';
    if (d.show_pay !== false) {
      if (d.pay_type === 'salary') {
        payRow = _portalAboutMeRow(t('aboutMePay'), t('aboutMeSalaried'));
      } else if (d.pay_rate == null || Number(d.pay_rate) === 0) {
        payRow = _portalAboutMeRow(t('aboutMePay'), t('aboutMeNotSet'));
      } else {
        payRow = _portalAboutMeRow(t('aboutMePay'), '$' + Number(d.pay_rate).toFixed(2) + ' ' + t('aboutMePayHourly'));
      }
    }
    body.innerHTML = ''
      + _portalAboutMeRow(t('accountNameLabel'), d.name)
      + _portalAboutMeRow(t('aboutMeRole'), d.team_label)
      + _portalAboutMeRow(t('aboutMeTenure'), d.tenure_text)
      + payRow
      + _portalAboutMeRow(t('aboutMeVacation'), d.vacation_text);
  } catch (e) { console.error('[portal about-me] render failed', e); }
}

// ── LANGUAGE ──
function openPortalLanguage() {
  try {
    var ov = document.getElementById('portal-language-overlay');
    var titleEl = document.getElementById('portal-language-title');
    if (titleEl) titleEl.textContent = t('languageTitle');
    if (ov) ov.style.display = 'flex';
    renderPortalLanguage();
  } catch (e) { console.error('[portal language] open failed', e); }
}
function closePortalLanguage() { var ov = document.getElementById('portal-language-overlay'); if (ov) ov.style.display = 'none'; }
function renderPortalLanguage() {
  try {
    var body = document.getElementById('portal-language-body');
    if (!body) return;
    var langs = [['en', 'English'], ['es', 'Español'], ['pt', 'Português'], ['cv', 'Kriolu']];
    body.innerHTML = langs.map(function (l) {
      var active = currentLang === l[0];
      return '<button type="button" onclick="choosePortalLanguage(\\'' + l[0] + '\\')" style="display:block;width:100%;text-align:left;min-height:44px;padding:12px 14px;margin-bottom:8px;border-radius:10px;cursor:pointer;font-family:\\'DM Sans\\',sans-serif;font-size:15px;font-weight:600;border:1px solid ' + (active ? 'var(--accent)' : 'var(--border)') + ';background:' + (active ? 'rgba(108,143,255,0.12)' : 'var(--surface2)') + ';color:var(--text)">' + (active ? '✓ ' : '') + l[1] + '</button>';
    }).join('');
  } catch (e) { console.error('[portal language] render failed', e); }
}
async function choosePortalLanguage(lang) {
  try {
    setPortalLang(lang);
    renderPortalLanguage();
    try { localStorage.setItem('penta_portal_lang', lang); } catch (e) {}
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (sb) {
      // Best-effort: saves to her real employees row once migration 119
      // is applied. If the RPC doesn't exist yet, this fails quietly --
      // the choice already took effect above and is already saved
      // per-device via localStorage either way.
      sb.rpc('update_my_employee_profile', { p_preferred_language: lang })
        .then(function (res) {
          if (res && res.error) console.warn('[portal language] could not save to her record yet (per-device only for now):', res.error.message);
        })
        .catch(function () {});
    }
  } catch (e) { console.error('[portal language] choose failed', e); }
}
"""

apply_edits([
    ("appUnlockEmployee: language fallback chain (per-device first, best-effort upgrade to her real column)", BOOT_LANG_OLD, BOOT_LANG_NEW),
    ("add hamburger menu + Account + About me + Language JS", "function portalGoHome() { showPortalTab('home'); }", "function portalGoHome() { showPortalTab('home'); }\n" + MENU_JS),
])
