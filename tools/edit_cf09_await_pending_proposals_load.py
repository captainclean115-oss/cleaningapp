#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- small correctness fix found
while writing STEP 6 tests. _claireOpenView called
_claireLoadPendingProposalsIntoChat() without awaiting it -- harmless in
practice (nothing runs after it), but sloppy: the function is async and
every other call in this codebase awaits its async collaborators.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  } catch (e) {
    console.warn('[claire] failed to load saved conversation:', e);
    _claireRenderSystemNote(_claireUserFacingError(new Error('claire_chat_sessions load failed: ' + ((e && e.message) || e))));
  }
  _claireLoadPendingProposalsIntoChat();
}"""

NEW = """  } catch (e) {
    console.warn('[claire] failed to load saved conversation:', e);
    _claireRenderSystemNote(_claireUserFacingError(new Error('claire_chat_sessions load failed: ' + ((e && e.message) || e))));
  }
  await _claireLoadPendingProposalsIntoChat();
}"""

EDITS = [("Claire: await the pending-proposals load in _claireOpenView", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
