#!/usr/bin/env python3
"""Employee portal polish, step 3: gate showPortalTab for
PORTAL_TABS_COMING_SOON tabs (no data fetched, Coming-soon screen shown
instead), add _renderPortalComingSoon, gate the Home-screen badges for
those same tabs, and keep setPortalLang from fetching schedule data
while gated."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

SHOWPORTALTAB_OLD = """function showPortalTab(tab) {
  // "home" returns to the icon grid and hides every sub-page.
  var screen = document.getElementById('portal-screen');
  if (tab === 'home') {
    if (screen) screen.classList.remove('in-subpage');
    currentTab = 'home';
    renderEmployeeHome();
    return;
  }
  // Content tile — skip the tab machinery and jump straight to the
  // shared content-capture flow that the Share button already uses.
  if (tab === 'content') {
    if (typeof portalShareContent === 'function') portalShareContent();
    return;
  }
  if (screen) screen.classList.add('in-subpage');
  ['schedule','hours','forms','handbook','rate','chat','rewards'].forEach(function(t) {
    var el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
    var pt = document.getElementById('ptab-' + t);
    if (pt) pt.classList.toggle('active', t === tab);
  });
  currentTab = tab;"""

SHOWPORTALTAB_NEW = """function showPortalTab(tab) {
  // "home" returns to the icon grid and hides every sub-page.
  var screen = document.getElementById('portal-screen');
  if (tab === 'home') {
    if (screen) screen.classList.remove('in-subpage');
    currentTab = 'home';
    renderEmployeeHome();
    return;
  }
  // Content tile — skip the tab machinery and jump straight to the
  // shared content-capture flow that the Share button already uses.
  if (tab === 'content') {
    if (typeof portalShareContent === 'function') portalShareContent();
    return;
  }
  if (screen) screen.classList.add('in-subpage');

  // Employee portal polish: a gated tab shows a "Coming soon" screen
  // instead of its real content div, and returns BEFORE any of this
  // tab's own render/fetch branches below ever run -- no data fetched
  // for it while hidden. PORTAL_TABS_COMING_SOON is the single flag;
  // emptying it is the only change needed to turn a tab back on.
  if (PORTAL_TABS_COMING_SOON.indexOf(tab) !== -1) {
    ['schedule','hours','forms','handbook','rate','chat','rewards'].forEach(function(t) {
      var el = document.getElementById('tab-' + t);
      if (el) el.style.display = 'none';
      var pt = document.getElementById('ptab-' + t);
      if (pt) pt.classList.toggle('active', t === tab);
    });
    PORTAL_TABS_COMING_SOON.forEach(function(t) {
      var cs = document.getElementById('tab-' + t + '-comingsoon');
      if (cs) cs.style.display = (t === tab) ? 'block' : 'none';
    });
    try { _renderPortalComingSoon(tab); } catch (e) { console.error('[portal] coming-soon render failed', e); }
    currentTab = tab;
    return;
  }
  // Not gated -- make sure any coming-soon host from a PRIOR tab switch
  // is hidden (only relevant while some tabs are gated and others not).
  PORTAL_TABS_COMING_SOON.forEach(function(t) {
    var cs = document.getElementById('tab-' + t + '-comingsoon');
    if (cs) cs.style.display = 'none';
  });

  ['schedule','hours','forms','handbook','rate','chat','rewards'].forEach(function(t) {
    var el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
    var pt = document.getElementById('ptab-' + t);
    if (pt) pt.classList.toggle('active', t === tab);
  });
  currentTab = tab;"""

RENDER_COMING_SOON_FN = """
// Employee portal polish -- renders the bilingual "Coming soon" message
// for a gated tab. Never fetches anything; pure DOM text.
function _renderPortalComingSoon(tab) {
  try {
    var host = document.getElementById('tab-' + tab + '-comingsoon');
    if (!host) return;
    var key = tab === 'schedule' ? 'scheduleComingSoon' : 'formsComingSoon';
    host.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--muted)">'
      + '<div style="font-size:32px;margin-bottom:12px">🚧</div>'
      + '<div style="font-size:15px;font-weight:600;color:var(--text)">' + _adminEsc(t(key)) + '</div>'
      + '</div>';
  } catch (e) { console.error('[portal] _renderPortalComingSoon failed', e); }
}
"""

BADGE_OLD = """  setBadge('emp-badge-schedule', _empTodayJobsCount());
  setBadge('emp-badge-chat',     _empUnreadChatCount());
  setBadge('emp-badge-forms',    _empPendingForms());"""

BADGE_NEW = """  // Employee portal polish: no count is fetched for a gated tab's
  // badge -- it just stays hidden, matching "no data fetched while
  // hidden" for schedule/forms specifically. Chat's badge is unaffected
  // (chat is never gated).
  if (PORTAL_TABS_COMING_SOON.indexOf('schedule') === -1) {
    setBadge('emp-badge-schedule', _empTodayJobsCount());
  } else {
    var _sbEl = document.getElementById('emp-badge-schedule'); if (_sbEl) _sbEl.style.display = 'none';
  }
  setBadge('emp-badge-chat', _empUnreadChatCount());
  if (PORTAL_TABS_COMING_SOON.indexOf('forms') === -1) {
    setBadge('emp-badge-forms', _empPendingForms());
  } else {
    var _fbEl = document.getElementById('emp-badge-forms'); if (_fbEl) _fbEl.style.display = 'none';
  }"""

SETPORTALLANG_OLD = """function setPortalLang(lang) {
  currentLang = lang;
  // Update portal lang buttons
  document.querySelectorAll('.portal-lang-btn').forEach((b, i) => {
    const langs = ['en','es','pt','cv'];
    b.classList.toggle('active', langs[i] === lang);
  });
  // Re-render all portal content
  updatePortalText();
  renderSchedule();
  renderHandbook();
  checkExistingSignature();
  // Re-render forms tab labels
  updateFormLabels();
}"""

SETPORTALLANG_NEW = """function setPortalLang(lang) {
  currentLang = lang;
  // Update portal lang buttons
  document.querySelectorAll('.portal-lang-btn').forEach((b, i) => {
    const langs = ['en','es','pt','cv'];
    b.classList.toggle('active', langs[i] === lang);
  });
  // Re-render all portal content
  updatePortalText();
  // Employee portal polish: don't fetch schedule data while that tab
  // is gated -- just re-render its (already-visible-or-not)
  // coming-soon text in the new language instead.
  if (PORTAL_TABS_COMING_SOON.indexOf('schedule') === -1) { renderSchedule(); }
  else { try { _renderPortalComingSoon('schedule'); } catch (e) {} }
  renderHandbook();
  checkExistingSignature();
  // Re-render forms tab labels
  updateFormLabels();
  if (PORTAL_TABS_COMING_SOON.indexOf('forms') !== -1) { try { _renderPortalComingSoon('forms'); } catch (e) {} }
  try { if (typeof _renderPortalMenuTexts === 'function') _renderPortalMenuTexts(); } catch (e) {}
}"""

apply_edits([
    ("showPortalTab: gate PORTAL_TABS_COMING_SOON tabs before any render/fetch branch", SHOWPORTALTAB_OLD, SHOWPORTALTAB_NEW),
    ("add _renderPortalComingSoon", "function portalGoHome() { showPortalTab('home'); }", "function portalGoHome() { showPortalTab('home'); }\n" + RENDER_COMING_SOON_FN),
    ("renderEmployeeHome: hide schedule/forms badges while gated, never fetch their counts", BADGE_OLD, BADGE_NEW),
    ("setPortalLang: don't fetch schedule data while gated; refresh coming-soon text + menu text", SETPORTALLANG_OLD, SETPORTALLANG_NEW),
])
