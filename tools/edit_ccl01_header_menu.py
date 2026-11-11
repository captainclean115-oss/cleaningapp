#!/usr/bin/env python3
"""Claire cleanup PART 1: header must be a slim bar ONLY.

Root cause of "header still takes 1/3 of the screen" after PR #222
(which only fixed the TEXT COLOR, not the layout): updateClaireVoiceHint()
auto-sets #claire-voice-hint to display:block whenever
shouldShowVoiceHint() is true -- which is the case on any iPhone that
doesn't already have an Enhanced/Premium voice downloaded (the common
case). That 4-line paragraph, plus the always-visible voice-name debug
line and the New chat/Clear history button row, were all still in the
ALWAYS-VISIBLE header flow -- just readable now instead of invisible.

Fix: move the voice-hint paragraph, the voice-name debug line, and the
New chat / Clear history buttons into a new, closed-by-default menu
sheet opened by a "..." button in the header bar. #claire-voice-hint
and #claire-voice-name keep their exact ids and are relocated verbatim
-- updateClaireVoiceHint()/claireSpeak() need ZERO changes, since their
own display:block/none toggling now happens inside an ancestor that is
ALSO hidden by default (the sheet), so the hint only actually becomes
visible on screen when both conditions are true: no premium voice AND
the user opened "Voice tips" -- never just the first one. The build
stamp (explicitly requested to stay) remains directly in the header.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """<div id="claire-view">
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
    <div id="claire-voice-hint" class="claire-voice-hint" style="display:none"></div>
    <!-- Debug line so Tom can see which voice actually got picked. -->
    <div id="claire-voice-name" style="font-size:10px;color:var(--muted);text-align:center;margin-top:4px"></div>
    <!-- Claire safety foundation (Stage 2a): saved-conversation controls. -->
    <div style="display:flex;gap:8px;justify-content:center;margin-top:10px">
      <button onclick="_claireStartNewChat()" type="button"
              style="padding:6px 14px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">New chat</button>
      <button onclick="_claireClearHistory()" type="button"
              style="padding:6px 14px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">Clear history</button>
    </div>
  </div>
  <div id="claire-messages" class="claire-view-messages"></div>
  <div class="claire-view-input-row">
    <input type="text" id="voice-cmd-input" class="claire-input" placeholder="Message Claire…" onkeydown="if(event.key==='Enter')runVoiceCmd()">
    <button onclick="runVoiceCmd()" class="claire-send" aria-label="Send">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    </button>
  </div>
</div>"""

NEW = """<div id="claire-view">
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
      <!-- Claire cleanup: "..." menu -- New chat / Clear history / Voice
           tips all live here now instead of the always-visible header, so
           a long voice-quality paragraph (shown by default on any device
           without a downloaded Enhanced/Premium voice -- see
           updateClaireVoiceHint()) can never blow up the header's height
           again. -->
      <button id="claire-menu-btn" class="claire-header-voice-btn" onclick="openClaireMenu()" type="button"
              aria-label="More options" title="More options">⋯</button>
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
  </div>
  <div id="claire-messages" class="claire-view-messages"></div>
  <div class="claire-view-input-row">
    <input type="text" id="voice-cmd-input" class="claire-input" placeholder="Message Claire…" onkeydown="if(event.key==='Enter')runVoiceCmd()">
    <button onclick="runVoiceCmd()" class="claire-send" aria-label="Send">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    </button>
  </div>
  <!-- Claire menu sheet: New chat / Clear history / Voice tips. Hidden by
       default (display:none); opened only by #claire-menu-btn. Houses
       #claire-voice-hint and #claire-voice-name VERBATIM (same ids) so
       updateClaireVoiceHint()/claireSpeak() need no changes -- their own
       display:block/none toggling now happens inside an ancestor
       (#claire-voice-tips-detail) that is ALSO closed by default, so the
       hint paragraph only ever becomes visible when the user explicitly
       opens "Voice tips," never just because the device lacks a premium
       voice. -->
  <div id="claire-menu-overlay" style="display:none;position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.4);align-items:flex-end;justify-content:center">
    <div style="background:var(--surface);width:100%;max-width:560px;border-radius:16px 16px 0 0;padding:16px 16px calc(var(--safe-bottom) + 16px);box-sizing:border-box">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:16px;font-weight:700;color:var(--text)">Claire</div>
        <button type="button" onclick="closeClaireMenu()" aria-label="Close"
                style="background:var(--surface2);border:1px solid var(--border);color:var(--text);width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;-webkit-tap-highlight-color:transparent">×</button>
      </div>
      <button type="button" onclick="closeClaireMenu();_claireStartNewChat()" type="button"
              style="display:block;width:100%;text-align:left;padding:13px 2px;background:none;border:none;border-bottom:1px solid var(--border);color:var(--text);font-size:15px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">New chat</button>
      <button type="button" onclick="closeClaireMenu();_claireClearHistory()"
              style="display:block;width:100%;text-align:left;padding:13px 2px;background:none;border:none;border-bottom:1px solid var(--border);color:var(--text);font-size:15px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">Clear history</button>
      <button type="button" onclick="_claireToggleVoiceTips()"
              style="display:block;width:100%;text-align:left;padding:13px 2px;background:none;border:none;color:var(--text);font-size:15px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">Voice tips</button>
      <div id="claire-voice-tips-detail" style="display:none;padding:2px 2px 0">
        <!-- Premium-voice hint: only rendered if no Enhanced/Premium voice is
             available on this device. Populated by updateClaireVoiceHint(). -->
        <div id="claire-voice-hint" class="claire-voice-hint" style="display:none"></div>
        <!-- Debug line so Tom can see which voice actually got picked. -->
        <div id="claire-voice-name" style="font-size:12px;color:var(--muted);text-align:center;margin-top:8px"></div>
      </div>
    </div>
  </div>
</div>"""

EDITS = [("Claire cleanup PART 1: slim header bar + New chat/Clear history/Voice tips moved into a menu sheet", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
