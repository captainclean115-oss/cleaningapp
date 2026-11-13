#!/usr/bin/env python3
"""Claire-draft-and-fallback fix -- PART A (last-error visibility).
Adds the #claire-last-error-line element to the Claire menu sheet
(right under the build stamp), renders it unconditionally at script
load (same pattern as _claireRenderBuildStamp, so a reload picks up
whatever was last persisted) and refreshes it every time the menu is
opened, so Tom always sees the freshest value without needing to
reload first.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_HTML = """      <div id="claire-build-stamp" class="claire-build-stamp-line" style="margin-bottom:10px"></div>"""

NEW_HTML = """      <div id="claire-build-stamp" class="claire-build-stamp-line" style="margin-bottom:4px"></div>
      <!-- Claire-draft-and-fallback fix: visible "what went wrong last
           time" line so Tom can check a failure reason without devtools. -->
      <div id="claire-last-error-line" style="font-size:11px;color:var(--muted);margin-bottom:10px"></div>"""

OLD_OPEN_MENU = """function openClaireMenu() {
  var el = document.getElementById('claire-menu-overlay');
  if (el) el.style.display = 'flex';
}"""

NEW_OPEN_MENU = """function openClaireMenu() {
  var el = document.getElementById('claire-menu-overlay');
  if (el) el.style.display = 'flex';
  if (typeof _claireRenderLastErrorLine === 'function') _claireRenderLastErrorLine();
}"""

EDITS = [
    ("Claire-draft-and-fallback fix: add the last-error line to the Claire menu sheet", OLD_HTML, NEW_HTML),
    ("Claire-draft-and-fallback fix: refresh the last-error line when the menu opens", OLD_OPEN_MENU, NEW_OPEN_MENU),
]

if __name__ == "__main__":
    apply_edits(EDITS)
