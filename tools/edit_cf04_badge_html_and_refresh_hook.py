#!/usr/bin/env python3
"""Claire safety foundation (Stage 2a) -- STEP 3F (badge).
Adds the "N waiting for approval" badge markup to Claire's bottom-nav
entry point (reusing the existing .dock-badge style, same visual
language as the other nav badges in this app), and hooks the refresh
into the existing role-resolution flow so it updates on sign-in and on
every role re-check -- no new polling loop, no new Edge Function.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_BADGE_HTML = """        <path d="M4 17v2"/>
        <path d="M5 18H3"/>
      </svg>
    </span>
  </button>
  <div class="nav-half nav-half-right" id="nav-half-right"></div>"""

NEW_BADGE_HTML = """        <path d="M4 17v2"/>
        <path d="M5 18H3"/>
      </svg>
    </span>
    <!-- Claire safety foundation (Stage 2a): count of pending
         claire_proposals visible to the signed-in user. Lives OUTSIDE
         .nav-icon-claire (overflow:hidden would clip it), same pattern
         as the other .dock-badge usages elsewhere in the nav. Hidden by
         default; _claireRefreshProposalBadge() shows/hides + sets the
         count, and hides it outright for the employee role. -->
    <span id="claire-proposal-badge" class="dock-badge" style="display:none">0</span>
  </button>
  <div class="nav-half nav-half-right" id="nav-half-right"></div>"""

OLD_ROLE_HOOK = """      _pentaResolveRoleFromDB(session.user.id).then(r => {
        if (r) {
          _pentaCachedRole = r;
          _pentaCachedRoleUserId = session.user.id;"""

NEW_ROLE_HOOK = """      _pentaResolveRoleFromDB(session.user.id).then(r => {
        if (r) {
          _pentaCachedRole = r;
          _pentaCachedRoleUserId = session.user.id;
          // Claire safety foundation (Stage 2a): role just resolved (or
          // re-resolved) for this session -- refresh the pending-proposal
          // badge now rather than waiting for Claire's own view to open.
          if (typeof _claireRefreshProposalBadge === 'function') _claireRefreshProposalBadge();"""

EDITS = [
    ("Claire: pending-proposal badge markup on the nav entry point", OLD_BADGE_HTML, NEW_BADGE_HTML),
    ("Claire: refresh the badge whenever role resolution completes", OLD_ROLE_HOOK, NEW_ROLE_HOOK),
]

if __name__ == "__main__":
    apply_edits(EDITS)
