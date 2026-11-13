#!/usr/bin/env python3
"""Claire-draft-and-fallback fix -- PART A (last-error visibility),
follow-up: the bare `_claireRenderBuildStamp();` load-time call string
also matches as a substring inside the showTab('claire') guarded call
site, so anchor on the full surrounding function definition instead.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function _claireRenderBuildStamp() {
  var el = document.getElementById('claire-build-stamp');
  if (el) el.textContent = 'Version ' + CLAIRE_BUILD_STAMP;
}
_claireRenderBuildStamp();"""

NEW = """function _claireRenderBuildStamp() {
  var el = document.getElementById('claire-build-stamp');
  if (el) el.textContent = 'Version ' + CLAIRE_BUILD_STAMP;
}
_claireRenderBuildStamp();
if (typeof _claireRenderLastErrorLine === 'function') _claireRenderLastErrorLine();"""

EDITS = [
    ("Claire-draft-and-fallback fix: render the last-error line at script load too", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
