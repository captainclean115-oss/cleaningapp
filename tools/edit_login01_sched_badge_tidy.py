#!/usr/bin/env python3
"""login-hang-fix -- PART 1. Remove the redundant _refreshSchedTileBadge()
direct call inside renderHomeScreen(). renderHomeScreen() already calls
renderDock() a few lines later, and renderDock() already calls
_refreshSchedTileBadge() itself (and is also the call used on cold boot,
DOMContentLoaded, independent of renderHomeScreen) -- so every home-tab
render was firing the badge refresh TWICE (12 redundant Supabase calls
instead of 6). Removing the direct call here does not change what the
badge displays or when it first updates; renderDock's own call (right
after, in the same render pass) covers it.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """  // v11.0.9 (Phase A): refresh the Schedule tile's unresolved-issues
  // count so the red-dot badge stays current on every home render.
  // Fire-and-forget — first paint uses the cached value (which may be
  // stale but is at most 1 render behind); the async refresh will
  // re-render the home if the count changed.
  try { _refreshSchedTileBadge(); } catch (e) {}
  // Same fire-and-forget contract as the Schedule badge above: first
  // paint uses the cached at-risk count, the async refresh re-renders
  // only if the number actually moved.
  try { _refreshClientHealthBadge(); } catch (e) {}"""

NEW = """  // v11.0.9 (Phase A): refresh the Schedule tile's unresolved-issues
  // count so the red-dot badge stays current on every home render.
  // Fire-and-forget — first paint uses the cached value (which may be
  // stale but is at most 1 render behind); the async refresh will
  // re-render the home if the count changed.
  // login-hang-fix: NOT called directly here anymore -- renderDock()
  // below already calls it, and renderDock() is also the standalone
  // boot-time trigger (see its own comment), so calling it here too
  // just fired the same 3 Supabase queries twice per home render.
  // Same fire-and-forget contract as the Schedule badge above: first
  // paint uses the cached at-risk count, the async refresh re-renders
  // only if the number actually moved.
  try { _refreshClientHealthBadge(); } catch (e) {}"""

EDITS = [
    ("login-hang-fix: remove redundant direct _refreshSchedTileBadge call in renderHomeScreen", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
