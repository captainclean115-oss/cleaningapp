#!/usr/bin/env python3
"""Claire auth-refresh fix -- STEP 5. Remove the "build 2026-11-11"
line from the always-visible Claire header; move it into the "..."
menu as small text, labeled "Version" instead of "build" (a non-
technical label fits the audience better than a raw build tag).
_claireRenderBuildStamp() keeps writing to the SAME element id
(#claire-build-stamp), just relocated -- no other JS change needed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_HTML = """    <!-- Claire build stamp: ALWAYS visible (rendered unconditionally at
         script-load by _claireRenderBuildStamp(), not gated on this view
         ever opening). This app has no service worker/build step -- an
         already-open tab or iOS home-screen PWA can keep running old JS
         indefinitely with no prompt to reload. If something Claire-related
         doesn't seem to be working, check this against the version in the
         latest shipped PR before assuming the code itself is wrong. -->
    <div id="claire-build-stamp" class="claire-build-stamp-line"></div>
    <div id="claire-waveform" class="claire-waveform">"""

NEW_HTML = """    <div id="claire-waveform" class="claire-waveform">"""

OLD_MENU = """      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:16px;font-weight:700;color:var(--text)">Claire</div>
        <button type="button" onclick="closeClaireMenu()" aria-label="Close"
                style="background:var(--surface2);border:1px solid var(--border);color:var(--text);width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;-webkit-tap-highlight-color:transparent">×</button>
      </div>"""

NEW_MENU = """      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div style="font-size:16px;font-weight:700;color:var(--text)">Claire</div>
        <button type="button" onclick="closeClaireMenu()" aria-label="Close"
                style="background:var(--surface2);border:1px solid var(--border);color:var(--text);width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;-webkit-tap-highlight-color:transparent">×</button>
      </div>
      <!-- Claire auth-refresh fix: moved out of the always-visible header
           (it was adding height there for no real benefit to Tom day to
           day) and into the menu, relabeled "Version" -- still rendered
           unconditionally at script-load by _claireRenderBuildStamp(),
           into this SAME element id, so an already-open tab/PWA running
           old JS is still checkable here if something seems off. -->
      <div id="claire-build-stamp" class="claire-build-stamp-line" style="margin-bottom:10px"></div>"""

EDITS = [
    ("Claire auth-refresh fix: remove build stamp from always-visible header", OLD_HTML, NEW_HTML),
    ("Claire auth-refresh fix: add build stamp (as 'Version') to the menu sheet", OLD_MENU, NEW_MENU),
]

if __name__ == "__main__":
    apply_edits(EDITS)
