#!/usr/bin/env python3
"""Claire approval-gate bypass fix -- STEP 2, JS half of the build stamp.
Defines CLAIRE_BUILD_STAMP (hand-bumped on every deploy that touches
Claire -- no build tooling exists in this single-file app to automate
it) and populates #claire-build-stamp whenever Claire's view opens.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_CONST = """// -----------------------------------------------------------------------
// CLAIRE SAFETY FOUNDATION (Stage 2a) -- approval-gate classification."""

NEW_CONST = """// Claire gate-bypass fix: visible build stamp (no build tooling exists
// in this single-file app, so this is bumped BY HAND on every deploy
// that touches Claire's gate/dispatch code -- see _claireRenderBuildStamp).
// Format: "gate-fix YYYY-MM-DD" -- change the date, not the prefix,
// unless the next change is a different fix/feature worth naming.
var CLAIRE_BUILD_STAMP = 'gate-fix 2026-11-11';
function _claireRenderBuildStamp() {
  var el = document.getElementById('claire-build-stamp');
  if (el) el.textContent = 'build: ' + CLAIRE_BUILD_STAMP;
}

// -----------------------------------------------------------------------
// CLAIRE SAFETY FOUNDATION (Stage 2a) -- approval-gate classification."""

OLD_HOOK = """  if (tab === 'claire' && typeof _claireOpenView === 'function') _claireOpenView();"""

NEW_HOOK = """  if (tab === 'claire') {
    if (typeof _claireRenderBuildStamp === 'function') _claireRenderBuildStamp();
    if (typeof _claireOpenView === 'function') _claireOpenView();
  }"""

EDITS = [
    ("Claire: CLAIRE_BUILD_STAMP constant + renderer", OLD_CONST, NEW_CONST),
    ("Claire: render the build stamp when her view opens", OLD_HOOK, NEW_HOOK),
]

if __name__ == "__main__":
    apply_edits(EDITS)
