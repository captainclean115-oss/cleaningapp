#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 3C (cards) + 3G (voice).
Wires _claireFlushProposalCards() into both wrap-up points (the normal
text-reply exit and the MAX_TOOL_ROUNDS cap), exactly mirroring the
existing _claireLastToolSmsLink flush pattern. Also adds one line to the
system prompt so Claude's own reply announces a proposal correctly in
voice mode ("I have a proposal for your approval") instead of leaving
the wording to chance -- this never changes the model, max_tokens, or
the Edge Function, just the prompt text already assembled client-side.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_FLUSH_1 = """      // Coach-Claire Phase 2: render the SMS "Send to <X>" button bubble
      // after the text reply, when send_response_to was called this turn.
      if (_claireLastToolSmsLink) {
        _claireRenderSmsButton(_claireLastToolSmsLink);
        _claireLastToolSmsLink = null;
      }
      return;
    }"""

NEW_FLUSH_1 = """      // Coach-Claire Phase 2: render the SMS "Send to <X>" button bubble
      // after the text reply, when send_response_to was called this turn.
      if (_claireLastToolSmsLink) {
        _claireRenderSmsButton(_claireLastToolSmsLink);
        _claireLastToolSmsLink = null;
      }
      // Claire safety foundation (Stage 2a): any proposal cards created
      // this turn render AFTER the text reply too, same slot as the SMS
      // button above -- one smooth reply, then whatever action cards go
      // with it.
      _claireFlushProposalCards();
      return;
    }"""

OLD_FLUSH_2 = """    if (_claireLastToolSmsLink) {
      _claireRenderSmsButton(_claireLastToolSmsLink);
      _claireLastToolSmsLink = null;
    }
  } catch(e) {"""

NEW_FLUSH_2 = """    if (_claireLastToolSmsLink) {
      _claireRenderSmsButton(_claireLastToolSmsLink);
      _claireLastToolSmsLink = null;
    }
    _claireFlushProposalCards();
  } catch(e) {"""

OLD_PROMPT = """    +'NEVER claim a UI action happened that you did not actually perform via a tool call. NEVER say "opening the form", "generating in the UI now", "loading it on screen", or anything implying you triggered something visual. Either you call the tool and report what came back, OR you tell the user what they need to do themselves. There is no third option.\\n\\n'"""

NEW_PROMPT = """    +'NEVER claim a UI action happened that you did not actually perform via a tool call. NEVER say "opening the form", "generating in the UI now", "loading it on screen", or anything implying you triggered something visual. Either you call the tool and report what came back, OR you tell the user what they need to do themselves. There is no third option.\\n'
    +'Any action tool (schedule/cancel/move a clean, change price or frequency, record a payment, edit a client or employee hours, send a text) now creates a PROPOSAL, not an immediate change -- the tool result will say "Proposal created... waiting for your approval. Nothing has changed yet." When you see that, say something like "I have a proposal for your approval" (or similarly plain, e.g. "I\\'ve set that up for your approval -- take a look"). NEVER say the action is done, saved, scheduled, cancelled, or sent when the result says a proposal was created -- it has not happened yet and only happens if the human taps Approve. If a tool result instead says "Only the owner or admin can do that" or "Only a manager or above can ask Claire to do that," relay that plainly and do not retry.\\n\\n'"""

EDITS = [
    ("Claire: flush proposal cards after the normal text-reply exit", OLD_FLUSH_1, NEW_FLUSH_1),
    ("Claire: flush proposal cards after the MAX_TOOL_ROUNDS wrap-up", OLD_FLUSH_2, NEW_FLUSH_2),
    ("Claire: system prompt -- proposal wording, never claim it's done", OLD_PROMPT, NEW_PROMPT),
]

if __name__ == "__main__":
    apply_edits(EDITS)
