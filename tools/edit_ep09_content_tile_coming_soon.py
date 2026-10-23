#!/usr/bin/env python3
"""Employee portal polish, round 3: the live set is exactly Hours,
Rewards, Learn, Chat. The Content tile (camera/share-content action)
was the one reachable thing besides Schedule/Forms not yet gated --
adds it to the SAME PORTAL_TABS_COMING_SOON flag. Content isn't a
normal persistent tab (showPortalTab jumps straight to
portalShareContent() instead of rendering a tab-content div), so its
own branch gets the explicit intercept rather than relying on the
generic tab loop, which never knew about 'content' to begin with."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

FLAG_OLD = "var PORTAL_TABS_COMING_SOON = ['schedule', 'forms'];"
FLAG_NEW = "var PORTAL_TABS_COMING_SOON = ['schedule', 'forms', 'content'];"

CONTENT_BRANCH_OLD = """  // Content tile — skip the tab machinery and jump straight to the
  // shared content-capture flow that the Share button already uses.
  if (tab === 'content') {
    if (typeof portalShareContent === 'function') portalShareContent();
    return;
  }"""

CONTENT_BRANCH_NEW = """  // Content tile — skip the tab machinery and jump straight to the
  // shared content-capture flow that the Share button already uses.
  // Employee portal polish: gated the same way as any other tab in
  // PORTAL_TABS_COMING_SOON -- Content has no persistent tab-content
  // div of its own (it's a direct camera/share action, not a screen),
  // so this intercept is explicit rather than falling through the
  // generic ['schedule',...,'rewards'] loop below, which never knew
  // about 'content' to begin with.
  if (tab === 'content') {
    if (PORTAL_TABS_COMING_SOON.indexOf('content') !== -1) {
      if (screen) screen.classList.add('in-subpage');
      ['schedule','hours','forms','handbook','rate','chat','rewards'].forEach(function(t) {
        var el = document.getElementById('tab-' + t);
        if (el) el.style.display = 'none';
        var pt = document.getElementById('ptab-' + t);
        if (pt) pt.classList.toggle('active', false);
      });
      PORTAL_TABS_COMING_SOON.forEach(function(t) {
        var cs = document.getElementById('tab-' + t + '-comingsoon');
        if (cs) cs.style.display = (t === 'content') ? 'block' : 'none';
      });
      try { _renderPortalComingSoon('content'); } catch (e) { console.error('[portal] coming-soon render failed', e); }
      currentTab = 'content';
      return;
    }
    if (typeof portalShareContent === 'function') portalShareContent();
    return;
  }"""

COMINGSOON_FN_OLD = """function _renderPortalComingSoon(tab) {
  try {
    var host = document.getElementById('tab-' + tab + '-comingsoon');
    if (!host) return;
    var key = tab === 'schedule' ? 'scheduleComingSoon' : 'formsComingSoon';"""

COMINGSOON_FN_NEW = """function _renderPortalComingSoon(tab) {
  try {
    var host = document.getElementById('tab-' + tab + '-comingsoon');
    if (!host) return;
    var key = tab === 'schedule' ? 'scheduleComingSoon' : tab === 'forms' ? 'formsComingSoon' : 'contentComingSoon';"""

apply_edits([
    ("PORTAL_TABS_COMING_SOON: add 'content'", FLAG_OLD, FLAG_NEW),
    ("showPortalTab: gate the Content tile the same way, before it launches the camera/share flow", CONTENT_BRANCH_OLD, CONTENT_BRANCH_NEW),
    ("_renderPortalComingSoon: map 'content' to its own translated message", COMINGSOON_FN_OLD, COMINGSOON_FN_NEW),
])
