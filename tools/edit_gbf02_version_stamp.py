#!/usr/bin/env python3
"""Claire approval-gate bypass fix -- STEP 2 (rule out stale cache).

This app is a single static index.html with no build step and no
service worker -- an already-open tab (or an iOS home-screen PWA)
keeps running whatever JS was loaded when it was opened, forever, with
no prompt to reload (see the existing Cache-Control meta-tag comment
near the top of this file). That means Tom could be running code from
BEFORE this fix (or before PR #219 entirely) with no visible way to
tell. Adds a small, visible build stamp to Claire's own header so he
can confirm which version is actually running on his phone, bump it by
hand on every deploy (no build tooling exists to automate this).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    <!-- Debug line so Tom can see which voice actually got picked. -->
    <div id="claire-voice-name" style="font-size:10px;color:rgba(255,255,255,0.30);text-align:center;margin-top:4px"></div>
    <!-- Claire safety foundation (Stage 2a): saved-conversation controls. -->"""

NEW = """    <!-- Debug line so Tom can see which voice actually got picked. -->
    <div id="claire-voice-name" style="font-size:10px;color:rgba(255,255,255,0.30);text-align:center;margin-top:4px"></div>
    <!-- Claire gate-bypass fix: visible build stamp. This app has no
         service worker/build step -- an already-open tab or iOS home-
         screen PWA can keep running old JS indefinitely with no
         prompt to reload. If something Claire-related doesn't seem
         to be working, check this against the version in the latest
         shipped PR before assuming the code itself is wrong. -->
    <div id="claire-build-stamp" style="font-size:10px;color:rgba(255,255,255,0.30);text-align:center;margin-top:2px"></div>
    <!-- Claire safety foundation (Stage 2a): saved-conversation controls. -->"""

EDITS = [("Claire: visible build-stamp element in her header", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
