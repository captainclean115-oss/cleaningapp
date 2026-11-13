#!/usr/bin/env python3
"""Claire-draft-and-fallback fix -- PART C (research mode).

Root cause of Tom's "Research mode -- pulling data and market
context..." on a drafting request: _detectClaireMode's action-verb
list is anchored to the start of the message ("^schedule", "^cancel",
etc.), so "Can you draft a text to..." never matched it (no leading
"can you" variant, and "draft" wasn't even in the list). The message
then fell through to the length>120 fallback (a long, dictated,
run-on sentence) and got routed into research mode -- wrong tone and
wrong system prompt for an operational drafting request.

Fix: a drafting-intent phrase anywhere in the message (not just at the
start) forces voice mode, checked BEFORE the length fallback, mirroring
the existing date-token-count check's own precedence for the same
reason (a payroll batch message is long but not a research question;
a drafting request is long but not a research question either).
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  // Bug fix: a dictated payroll batch ("9/8-934-637 10lunch 9/9-906-610.
  // 10 lunch 9/10 910-722 10lunch ...") doesn't start with an action verb
  // (no "set"/"change" -- Tom just lists dates) and easily blows past 120
  // chars from date/time volume alone once it covers a week or more, not
  // because it reads like a research question. The old length-only
  // fallback below routed that straight into research mode (wrong tone --
  // "Research mode -- pulling data and market context..." on a payroll
  // edit -- and wrong max_tokens/system prompt for an operational batch).
  // 2+ M/D date tokens is a strong, specific signal on its own: a real
  // research question never reads like a date list, so this check runs
  // BEFORE the length fallback and wins regardless of length.
  if ((t.match(/\\b\\d{1,2}\\/\\d{1,2}\\b/g) || []).length >= 2) return 'voice';
  // Long messages without action flavor → research.
  if (t.length > 120) return 'research';
  return 'voice';
}"""

NEW = """  // Bug fix: a dictated payroll batch ("9/8-934-637 10lunch 9/9-906-610.
  // 10 lunch 9/10 910-722 10lunch ...") doesn't start with an action verb
  // (no "set"/"change" -- Tom just lists dates) and easily blows past 120
  // chars from date/time volume alone once it covers a week or more, not
  // because it reads like a research question. The old length-only
  // fallback below routed that straight into research mode (wrong tone --
  // "Research mode -- pulling data and market context..." on a payroll
  // edit -- and wrong max_tokens/system prompt for an operational batch).
  // 2+ M/D date tokens is a strong, specific signal on its own: a real
  // research question never reads like a date list, so this check runs
  // BEFORE the length fallback and wins regardless of length.
  if ((t.match(/\\b\\d{1,2}\\/\\d{1,2}\\b/g) || []).length >= 2) return 'voice';
  // Claire-draft-and-fallback fix: "Can you draft a text to the client
  // [...] and we have not received one in the past nine cleans and the
  // balance is $1917 ..." -- a long, dictated drafting request doesn't
  // start with an action verb either (the verb list above is anchored
  // to the start of the message, and "draft"/"write" weren't even on
  // it), so it fell through to the length fallback below and got
  // routed into research mode purely because it ran long, not because
  // it reads like a research question. Checked here, before the
  // length fallback, for the same reason the date-token check above
  // is: the signal itself (asking to draft/write/compose a message)
  // is strong and specific regardless of message length.
  if (/\\b(draft|compose)\\b/.test(t) || /\\bwrite\\b.{0,40}\\b(text|message|email|note)\\b/.test(t)) return 'voice';
  // Long messages without action flavor → research.
  if (t.length > 120) return 'research';
  return 'voice';
}"""

EDITS = [
    ("Claire-draft-and-fallback fix: drafting phrases stay in voice mode, never research", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
