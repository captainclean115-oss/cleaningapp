#!/usr/bin/env python3
"""Claire cleanup PART 3: bubble sizing.

Bubbles sat inside a column-flex wrapper (align-items: flex-end/
flex-start) with no explicit width -- correct for most content, but
with no min-width floor a very short message (a couple of words) could
end up narrower than its own natural text width under certain flex-
shrink conditions, wrapping unnecessarily. width: fit-content (with a
-webkit- prefix for older iOS Safari) makes the bubble size to its
content's natural width explicitly, bounded by max-width, regardless of
any ambient flex-shrink behavior -- the most direct fix for "a 2-word
message must not wrap." min-width gives very short content (a single
word, an emoji) a sensible floor instead of looking like a tiny sliver.
max-width bumped from 82% to the requested ~85%.

Proposal cards (tests/claire-approval-gate.test.js's cards) are
rendered as the INNER content of a .claire-bubble-claire div (see
_claireRenderBubble -> _claireDispatchOrPropose's call), so they
automatically inherit these exact same width rules with no separate
change needed -- confirmed, not assumed.

The timestamp-below-bubble structure in _claireRenderBubble was already
correct (a sibling div in the same column wrapper, no absolute
positioning or negative margins) -- unchanged here, just reconfirmed.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """.claire-bubble-claire {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px 16px 16px 4px;
  padding: 9px 13px;
  font-size: 14px; line-height: 1.45; color: var(--text);
  max-width: 82%; word-wrap: break-word;
}
.claire-bubble-user {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-radius: 16px 16px 4px 16px;
  padding: 9px 13px;
  font-size: 14px; line-height: 1.45;
  max-width: 82%; word-wrap: break-word;
}"""

NEW = """.claire-bubble-claire {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px 16px 16px 4px;
  padding: 9px 13px;
  font-size: 14px; line-height: 1.45; color: var(--text);
  width: -webkit-fit-content; width: fit-content;
  min-width: 48px; max-width: 85%; word-wrap: break-word;
}
.claire-bubble-user {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-radius: 16px 16px 4px 16px;
  padding: 9px 13px;
  font-size: 14px; line-height: 1.45;
  width: -webkit-fit-content; width: fit-content;
  min-width: 48px; max-width: 85%; word-wrap: break-word;
}"""

EDITS = [("Claire cleanup PART 3: bubbles size to content with a min-width floor, max-width bumped to 85%", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
