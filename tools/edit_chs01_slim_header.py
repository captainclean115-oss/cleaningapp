#!/usr/bin/env python3
"""Claire header redesign (PART B) + build-stamp visibility fix.

ROOT CAUSE of the invisible build stamp (and, it turns out, several
neighboring elements): this app's actual page background is solid
white (--bg-gradient: #FFFFFF), but the build stamp, the voice-toggle
button, the voice-name debug line, the voice hint, and the New chat/
Clear history buttons were all styled with white text/fills
(color:#fff, rgba(255,255,255,0.08-0.5)) -- a color scheme that only
makes sense on a DARK background. Confirmed via a live headless
screenshot: Claire's name and status render fine (they already used
var(--text)/var(--muted)), but everything below them is a near-
invisible white-on-white ghost.

Fix, in one pass:
  1. Every text/fill color in this block switches to var(--text) /
     var(--muted) / var(--surface2) / var(--border) -- the SAME
     light-theme tokens already used successfully by buttons elsewhere
     in this app (e.g. the "Cancel" buttons in the staff-login-fix and
     temp-password modals use this exact background/color/border
     combination).
  2. PART B slim header: a single ~56px flex row (small 40px avatar,
     "Claire" + Online dot, voice toggle collapsed to an icon-only
     button on the right -- no more separate "Voice on"/"Voice off"
     text row). The build stamp becomes one small, clearly readable
     line directly under that bar.
  3. toggleClaireVoice()'s _claireUpdateVoiceToggleUI already null-
     guards `label` (the text span being removed), so no JS change is
     needed there.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_CSS = """.claire-identity { flex: 1; min-width: 0; }
.claire-name { font-size: 16px; font-weight: 700; letter-spacing: -0.2px; }
.claire-status { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 5px; margin-top: 1px; }
.claire-online-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.6); }"""

NEW_CSS = """.claire-identity { flex: 1; min-width: 0; }
.claire-name { font-size: 16px; font-weight: 700; letter-spacing: -0.2px; }
.claire-status { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 5px; margin-top: 1px; }
.claire-online-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.6); }
/* Claire header redesign (PART B): a single slim bar instead of the old
   tall, centered, vertically-stacked stage. Avatar shrinks to 40px
   (overriding .claire-big-avatar's 140px base) but KEEPS the
   .claire-big-avatar class name so the existing .speaking breathe/glow
   animation still targets it -- only size/shadow are overridden here. */
.claire-header-bar {
  display: flex; align-items: center; gap: 10px;
  width: 100%; min-height: 56px;
}
.claire-header-bar .claire-big-avatar {
  width: 40px; height: 40px; font-size: 18px;
  box-shadow: 0 2px 8px rgba(108,143,255,0.3);
  flex-shrink: 0;
}
.claire-header-voice-btn {
  flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface2); color: var(--text);
  border: 1px solid var(--border);
  font-size: 16px; cursor: pointer; padding: 0;
  -webkit-tap-highlight-color: transparent;
}
.claire-build-stamp-line {
  font-size: 12px; color: var(--muted);
  text-align: left; margin-top: 2px;
}"""

OLD_HTML = """<div id="claire-view">
  <div class="claire-view-stage">
    <div class="claire-big-avatar" id="claire-big-avatar" onclick="openClairePhotoPicker()" title="Tap to change photo">
      <span id="claire-avatar-letter">C</span>
      <div class="claire-avatar-edit">✎</div>
      <!-- D-ID video element disabled 2026-04-18 — switched to Web Speech API.
           Kept in comment for rollback reference.
      <video id="claire-video" playsinline></video>
      -->
    </div>
    <div class="claire-identity" style="text-align:center;margin-top:14px">
      <div class="claire-name" style="font-size:20px;font-weight:700">Claire</div>
      <div class="claire-status" style="justify-content:center;margin-top:2px"><span class="claire-online-dot"></span><span id="claire-status-text">Online · Your AI assistant</span></div>
    </div>
    <!-- Feature: voice on/off toggle. Always visible (unlike #claire-stop-btn,
         which only shows mid-speech) so it can be flipped mid-conversation
         without hunting through a settings screen -- there isn't one for
         Claire today; this is deliberately a direct control in her own view. -->
    <button id="claire-voice-toggle-btn" onclick="toggleClaireVoice()" type="button"
            aria-pressed="true" title="Turn Claire's spoken replies on or off"
            style="display:flex; align-items:center; gap:6px; margin:10px auto 0; padding:6px 16px;
                   background:rgba(255,255,255,0.08); color:#fff;
                   border:1px solid rgba(255,255,255,0.22); border-radius:20px;
                   font-size:13px; font-weight:600; cursor:pointer;
                   -webkit-tap-highlight-color: transparent;">
      <span id="claire-voice-toggle-icon">🔊</span><span id="claire-voice-toggle-label">Voice on</span>
    </button>
    <div id="claire-waveform" class="claire-waveform">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <button id="claire-stop-btn" onclick="claireStopSpeaking()" type="button"
            style="display:none; margin-top:12px; padding:8px 20px;
                   background:rgba(255,255,255,0.08); color:#fff;
                   border:1px solid rgba(255,255,255,0.22); border-radius:20px;
                   font-size:14px; font-weight:600; cursor:pointer;
                   -webkit-tap-highlight-color: transparent;">
      ⏸ Stop
    </button>
    <!-- Premium-voice hint: only rendered if no Enhanced/Premium voice is
         available on this device. Populated by updateClaireVoiceHint(). -->
    <div id="claire-voice-hint" class="claire-voice-hint" style="display:none"></div>
    <!-- Debug line so Tom can see which voice actually got picked. -->
    <div id="claire-voice-name" style="font-size:10px;color:rgba(255,255,255,0.30);text-align:center;margin-top:4px"></div>
    <!-- Claire gate-bypass fix: visible build stamp. This app has no
         service worker/build step -- an already-open tab or iOS home-
         screen PWA can keep running old JS indefinitely with no
         prompt to reload. If something Claire-related doesn't seem
         to be working, check this against the version in the latest
         shipped PR before assuming the code itself is wrong. -->
    <div id="claire-build-stamp" style="font-size:10px;color:rgba(255,255,255,0.30);text-align:center;margin-top:2px"></div>
    <!-- Claire safety foundation (Stage 2a): saved-conversation controls. -->
    <div style="display:flex;gap:8px;justify-content:center;margin-top:10px">
      <button onclick="_claireStartNewChat()" type="button"
              style="padding:6px 14px;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.22);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">New chat</button>
      <button onclick="_claireClearHistory()" type="button"
              style="padding:6px 14px;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.22);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">Clear history</button>
    </div>
  </div>"""

NEW_HTML = """<div id="claire-view">
  <div class="claire-view-stage">
    <div class="claire-header-bar">
      <div class="claire-big-avatar" id="claire-big-avatar" onclick="openClairePhotoPicker()" title="Tap to change photo">
        <span id="claire-avatar-letter">C</span>
        <!-- D-ID video element disabled 2026-04-18 — switched to Web Speech API.
             Kept in comment for rollback reference.
        <video id="claire-video" playsinline></video>
        -->
      </div>
      <div class="claire-identity">
        <div class="claire-name">Claire</div>
        <div class="claire-status"><span class="claire-online-dot"></span><span id="claire-status-text">Online · Your AI assistant</span></div>
      </div>
      <!-- Feature: voice on/off toggle. Always visible (unlike #claire-stop-btn,
           which only shows mid-speech) so it can be flipped mid-conversation
           without hunting through a settings screen -- there isn't one for
           Claire today; this is deliberately a direct control in her own
           header. Collapsed to an icon-only button (PART B) -- the label
           span is gone, but _claireUpdateVoiceToggleUI already null-guards
           its lookup of #claire-voice-toggle-label, so no JS change needed. -->
      <button id="claire-voice-toggle-btn" class="claire-header-voice-btn" onclick="toggleClaireVoice()" type="button"
              aria-pressed="true" aria-label="Turn Claire's spoken replies on or off" title="Turn Claire's spoken replies on or off">
        <span id="claire-voice-toggle-icon">🔊</span>
      </button>
    </div>
    <!-- Claire build stamp: ALWAYS visible (rendered unconditionally at
         script-load by _claireRenderBuildStamp(), not gated on this view
         ever opening). This app has no service worker/build step -- an
         already-open tab or iOS home-screen PWA can keep running old JS
         indefinitely with no prompt to reload. If something Claire-related
         doesn't seem to be working, check this against the version in the
         latest shipped PR before assuming the code itself is wrong. -->
    <div id="claire-build-stamp" class="claire-build-stamp-line"></div>
    <div id="claire-waveform" class="claire-waveform">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <button id="claire-stop-btn" onclick="claireStopSpeaking()" type="button"
            style="display:none; margin-top:12px; padding:8px 20px;
                   background:var(--surface2); color:var(--text);
                   border:1px solid var(--border); border-radius:20px;
                   font-size:14px; font-weight:600; cursor:pointer;
                   -webkit-tap-highlight-color: transparent;">
      ⏸ Stop
    </button>
    <!-- Premium-voice hint: only rendered if no Enhanced/Premium voice is
         available on this device. Populated by updateClaireVoiceHint(). -->
    <div id="claire-voice-hint" class="claire-voice-hint" style="display:none;color:var(--muted)"></div>
    <!-- Debug line so Tom can see which voice actually got picked. -->
    <div id="claire-voice-name" style="font-size:10px;color:var(--muted);text-align:center;margin-top:4px"></div>
    <!-- Claire safety foundation (Stage 2a): saved-conversation controls. -->
    <div style="display:flex;gap:8px;justify-content:center;margin-top:10px">
      <button onclick="_claireStartNewChat()" type="button"
              style="padding:6px 14px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">New chat</button>
      <button onclick="_claireClearHistory()" type="button"
              style="padding:6px 14px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">Clear history</button>
    </div>
  </div>"""

EDITS = [
    ("Claire header: add compact-bar/voice-btn/build-stamp CSS", OLD_CSS, NEW_CSS),
    ("Claire header: slim 56px bar markup + readable colors throughout", OLD_HTML, NEW_HTML),
]

if __name__ == "__main__":
    apply_edits(EDITS)
