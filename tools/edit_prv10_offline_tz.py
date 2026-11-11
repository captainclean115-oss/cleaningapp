#!/usr/bin/env python3
"""Claire proposal-resolve-verify -- STEP 1.3 (business-timezone "today").

processVoiceCommandLocal's offline cancel/uncancel branches pre-filled
a "today" date with dateKey(new Date()) -- DEVICE-local time -- before
ever reaching _claireDispatchOrPropose's new resolver. Since the
resolver only applies its OWN business-timezone-aware default
(_claireTodayKey()) when input.date is falsy, a wrong device-local date
computed here would silently override the resolver's correct default.
Switching these two call sites to _claireTodayKey() directly closes
that gap.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """    var uncancelTargetDate = resultU.date || dateKey(new Date());"""
NEW1 = """    var uncancelTargetDate = resultU.date || _claireTodayKey();"""

OLD2 = """    var cancelTargetDate = result2.date || dateKey(new Date());"""
NEW2 = """    var cancelTargetDate = result2.date || _claireTodayKey();"""

EDITS = [
    ("Claire proposal-resolve-verify: offline uncancel 'today' uses business timezone", OLD1, NEW1),
    ("Claire proposal-resolve-verify: offline cancel 'today' uses business timezone", OLD2, NEW2),
]

if __name__ == "__main__":
    apply_edits(EDITS)
