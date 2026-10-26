#!/usr/bin/env python3
"""Employee portal polish, step 2: add the two "Coming soon" host divs
as SIBLINGS of tab-schedule/tab-forms (never touching those divs'
existing markup at all) -- when PORTAL_TABS_COMING_SOON is emptied out
later, the real tabs are fully intact, nothing to restore."""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

apply_edits([
    (
        "add tab-schedule-comingsoon host div",
        '    <div id="schedule-list">\n'
        '      <div style="color:var(--muted);text-align:center;padding:40px 20px;font-size:14px" id="no-jobs-text">No jobs scheduled for today</div>\n'
        '    </div>\n'
        '  </div>\n'
        '\n'
        '  <!-- HOURS TAB -->',
        '    <div id="schedule-list">\n'
        '      <div style="color:var(--muted);text-align:center;padding:40px 20px;font-size:14px" id="no-jobs-text">No jobs scheduled for today</div>\n'
        '    </div>\n'
        '  </div>\n'
        '\n'
        '  <!-- SCHEDULE "COMING SOON" (employee portal polish) -- sibling of\n'
        '       tab-schedule, never overwrites it. Shown instead of tab-schedule\n'
        '       while \'schedule\' is in PORTAL_TABS_COMING_SOON. -->\n'
        '  <div id="tab-schedule-comingsoon" class="section" style="display:none"></div>\n'
        '\n'
        '  <!-- HOURS TAB -->',
    ),
    (
        "add tab-forms-comingsoon host div",
        '        <div id="esign-signed-display" style="display:none"></div>\n'
        '      </div>\n'
        '    </div>\n'
        '  </div>\n'
        '\n'
        '  <!-- RATE WEEK TAB -->',
        '        <div id="esign-signed-display" style="display:none"></div>\n'
        '      </div>\n'
        '    </div>\n'
        '  </div>\n'
        '\n'
        '  <!-- FORMS "COMING SOON" (employee portal polish) -- sibling of\n'
        '       tab-forms, never overwrites it. Shown instead of tab-forms while\n'
        '       \'forms\' is in PORTAL_TABS_COMING_SOON. NOTE: the handbook\n'
        '       acknowledgment/signature flow is rendered INSIDE tab-forms today\n'
        '       (see "Hidden handbook tab (content moved to forms)" just below)\n'
        '       -- gating \'forms\' makes it unreachable too. Flagged in the PR,\n'
        '       not silently worked around. -->\n'
        '  <div id="tab-forms-comingsoon" class="section" style="display:none"></div>\n'
        '\n'
        '  <!-- RATE WEEK TAB -->',
    ),
])
