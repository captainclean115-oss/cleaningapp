#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 4 wiring.
Hooks _claireOpenView() into showTab('claire'), calls
_claireSaveConversationTurn() at both turn-boundary wrap-up points
(right alongside the existing _claireFlushProposalCards() calls added
in cf03), and adds the New Chat / Clear History buttons to Claire's
own view.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_SHOWTAB = """  var claireView = document.getElementById('claire-view');
  if (claireView) claireView.classList.toggle('active', tab === 'claire');"""

NEW_SHOWTAB = """  var claireView = document.getElementById('claire-view');
  if (claireView) claireView.classList.toggle('active', tab === 'claire');
  // Claire safety foundation (Stage 2a): load the user's most recent
  // saved conversation (or start fresh) + any pending proposals, once
  // per page load.
  if (tab === 'claire' && typeof _claireOpenView === 'function') _claireOpenView();"""

OLD_SAVE_1 = """      // Claire safety foundation (Stage 2a): any proposal cards created
      // this turn render AFTER the text reply too, same slot as the SMS
      // button above -- one smooth reply, then whatever action cards go
      // with it.
      _claireFlushProposalCards();
      return;
    }"""

NEW_SAVE_1 = """      // Claire safety foundation (Stage 2a): any proposal cards created
      // this turn render AFTER the text reply too, same slot as the SMS
      // button above -- one smooth reply, then whatever action cards go
      // with it.
      _claireFlushProposalCards();
      // Whole-turn save -- _claireHistory's last entry is this turn's
      // final text-only assistant message, a genuine turn boundary.
      _claireSaveConversationTurn();
      return;
    }"""

OLD_SAVE_2 = """    if (_claireLastToolSmsLink) {
      _claireRenderSmsButton(_claireLastToolSmsLink);
      _claireLastToolSmsLink = null;
    }
    _claireFlushProposalCards();
  } catch(e) {"""

NEW_SAVE_2 = """    if (_claireLastToolSmsLink) {
      _claireRenderSmsButton(_claireLastToolSmsLink);
      _claireLastToolSmsLink = null;
    }
    _claireFlushProposalCards();
    // Whole-turn save -- the round cap was only reached after the last
    // round's tool_results were already pushed, so this is also a
    // well-paired boundary, never a dangling tool_use.
    _claireSaveConversationTurn();
  } catch(e) {"""

OLD_BUTTONS = """    <!-- Debug line so Tom can see which voice actually got picked. -->
    <div id="claire-voice-name" style="font-size:10px;color:rgba(255,255,255,0.30);text-align:center;margin-top:4px"></div>
  </div>
  <div id="claire-messages" class="claire-view-messages"></div>"""

NEW_BUTTONS = """    <!-- Debug line so Tom can see which voice actually got picked. -->
    <div id="claire-voice-name" style="font-size:10px;color:rgba(255,255,255,0.30);text-align:center;margin-top:4px"></div>
    <!-- Claire safety foundation (Stage 2a): saved-conversation controls. -->
    <div style="display:flex;gap:8px;justify-content:center;margin-top:10px">
      <button onclick="_claireStartNewChat()" type="button"
              style="padding:6px 14px;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.22);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">New chat</button>
      <button onclick="_claireClearHistory()" type="button"
              style="padding:6px 14px;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.22);border-radius:16px;font-size:12px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent">Clear history</button>
    </div>
  </div>
  <div id="claire-messages" class="claire-view-messages"></div>"""

EDITS = [
    ("Claire: load saved conversation + pending proposals when the tab opens", OLD_SHOWTAB, NEW_SHOWTAB),
    ("Claire: save the turn after the normal text-reply exit", OLD_SAVE_1, NEW_SAVE_1),
    ("Claire: save the turn after the MAX_TOOL_ROUNDS wrap-up", OLD_SAVE_2, NEW_SAVE_2),
    ("Claire: New chat / Clear history buttons", OLD_BUTTONS, NEW_BUTTONS),
]

if __name__ == "__main__":
    apply_edits(EDITS)
