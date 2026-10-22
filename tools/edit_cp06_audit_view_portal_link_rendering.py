#!/usr/bin/env python3
"""Claire portal-links feature, step 6: without this, a Claire-sent
invite/reset audit row (action_type='manual_note', entity_type=
'employee') would still render safely in the Activity Log (the generic
employee-entity fallback already handles any action_type without
crashing or leaking anything), but as the clunky literal
"Claire manual_note staff member Maria Vieira". This adds one specific
case ahead of that fallback so it reads like the other audit entries do.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import apply_edits

OLD = """    } else {
      summary = _audEsc(actor) + ' ' + _audEsc(at) + ' staff member <strong>' + _audEsc(en2) + '</strong>';
    }
    drill = { type: 'employee', id: row.entity_id };
  }"""

NEW = """    } else if (at === 'manual_note' && nv.source === 'claire_portal_link') {
      // Claire portal-links feature -- never shows the link/token
      // itself (new_values never has one), only the outcome Claire
      // already reported in chat.
      var plVerb = (nv.type === 'reset') ? 'password reset link' : 'portal invite';
      if (nv.result === 'sent') {
        summary = _audEsc(actor) + ' sent a ' + plVerb + ' to <strong>' + _audEsc(en2) + '</strong> via Claire';
      } else {
        summary = _audEsc(actor) + ' tried to send a ' + plVerb + ' to <strong>' + _audEsc(en2) + '</strong> via Claire — failed'
          + (nv.reason ? (': ' + _audEsc(_audTrunc(nv.reason, 80))) : '');
      }
    } else {
      summary = _audEsc(actor) + ' ' + _audEsc(at) + ' staff member <strong>' + _audEsc(en2) + '</strong>';
    }
    drill = { type: 'employee', id: row.entity_id };
  }"""

apply_edits([
    ("Activity Log: render Claire portal-link audit rows cleanly", OLD, NEW),
])
