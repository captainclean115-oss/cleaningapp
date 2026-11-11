#!/usr/bin/env python3
"""Part E addition: the Claire build stamp must be ALWAYS visible in her
header, not gated on the view opening.

Before: CLAIRE_BUILD_STAMP was only rendered inside showTab's
`tab === 'claire'` branch (via _claireRenderBuildStamp()) -- so a user
who never opened Claire's tab (or opened it once per app-load after a
long session) could not see it, and it was invisible until that one
conditional fired. Fix: render it unconditionally, once, at script-load
time -- the #claire-build-stamp element is static markup that already
exists in the DOM by the time this script runs (it's a single giant
inline <script> after all of the page's HTML), so no DOMContentLoaded
wait is needed. The showTab call stays too (harmless, re-renders the
same constant) so re-opening Claire after a long-lived tab still shows
the same thing, but visibility no longer DEPENDS on it.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """// Claire gate-bypass fix: visible build stamp (no build tooling exists
// in this single-file app, so this is bumped BY HAND on every deploy
// that touches Claire's gate/dispatch code -- see _claireRenderBuildStamp).
// Format: "gate-fix YYYY-MM-DD" -- change the date, not the prefix,
// unless the next change is a different fix/feature worth naming.
var CLAIRE_BUILD_STAMP = 'gate-fix 2026-11-11';
function _claireRenderBuildStamp() {
  var el = document.getElementById('claire-build-stamp');
  if (el) el.textContent = 'build: ' + CLAIRE_BUILD_STAMP;
}"""

NEW = """// Claire build stamp -- ALWAYS visible in her header, never gated on
// the view opening. No build tooling exists in this single-file app,
// so CLAIRE_BUILD_STAMP is bumped BY HAND on every deploy that touches
// Claire's gate/dispatch code (format: short date "YYYY-MM-DD", easiest
// to read at a glance and to keep accurate without a real build step --
// a short commit hash would need to be known before the commit that
// contains it exists, which isn't possible without CI). Rendered
// unconditionally right here at script-load time -- #claire-build-stamp
// is static markup that already exists in the DOM by now (this whole
// app is one inline <script> after all of the page's HTML), so
// visibility never depends on Claire's tab ever being opened. The
// showTab('claire') call site re-renders the same constant too
// (harmless, just keeps a long-lived open tab's display consistent).
var CLAIRE_BUILD_STAMP = '2026-11-11';
function _claireRenderBuildStamp() {
  var el = document.getElementById('claire-build-stamp');
  if (el) el.textContent = 'build ' + CLAIRE_BUILD_STAMP;
}
_claireRenderBuildStamp();"""

EDITS = [("Claire: build stamp renders unconditionally at script-load, not gated on view opening", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
