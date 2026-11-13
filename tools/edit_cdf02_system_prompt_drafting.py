#!/usr/bin/env python3
"""Claire-draft-and-fallback fix -- PART B. Adds an explicit DRAFTING
section to the system prompt, same style/placement as the existing
QUOTE FLOW / HOURS FLOW sections. There was previously no mention of
drafting a message anywhere in the prompt at all -- a request to
"draft a text" had no documented behavior, no tool, and no approval
exemption, which is the gap behind Tom's exact bug report (on top of
the research-mode misrouting fixed separately).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    +'You can also send any response as SMS to ' + _opName + ' or a named employee using send_response_to — useful when ' + _opName + ' asks "text me this" or "send this to Lisa." Always confirm what is about to be sent before the tool call when the message is long.\\n\\n'"""

NEW = """    +'DRAFTING A MESSAGE (text, email, or note) -- follow this exactly:\\n'
    +'This is READ-ONLY and needs no approval -- writing a draft changes nothing. Never create a proposal and never call send_text/send_message/send_response_to for a plain drafting request, even if ' + _opName + ' asks you to send the draft to themselves -- just show it in chat; they copy and send it from their own phone/app.\\n'
    +'1. If the client is not clearly named in the request, or the name matches more than one client, ask ONE short question listing the candidates ("Which client — X or Y?") and wait for the answer. Never guess.\\n'
    +'2. Once the client is resolved, call lookup_balance (and lookup_schedule or count_jobs if useful) to pull their REAL current balance, last payment date, and number of cleans since -- never invent or assume these numbers. If ' + _opName + ' gave you a dollar figure or a count in their message and it disagrees with what the tools return, say so plainly and use the real figure in the draft (e.g. "Heads up — you said $1,917, the system shows a different number — I used what the system shows.").\\n'
    +'3. Write the draft message itself wrapped in a plain ``` fenced block with nothing else inside the fence but the exact text to send -- one short lead-in sentence before it, nothing after. Example:\\n'
    +'   Here\\'s a draft for Jane Smith:\\n```\\nHi Jane, this is [Business] — we show a balance of $X and haven\\'t received a check in your last N cleans. Could you leave one out for pickup today? Thanks!\\n```\\n\\n'
    +'You can also send any response as SMS to ' + _opName + ' or a named employee using send_response_to — useful when ' + _opName + ' asks "text me this" or "send this to Lisa." Always confirm what is about to be sent before the tool call when the message is long. This is for sending something Claire herself composes and dispatches, never a drafting request (rule above) -- those are never sent by Claire at all.\\n\\n'"""

EDITS = [
    ("Claire-draft-and-fallback fix: add the DRAFTING system-prompt section", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
