#!/usr/bin/env python3
"""Edit 11/N -- salaried Admin/Office feature.

Claire's own roster context string + system prompt instruction, so her
reasoning (not just the deterministic tool code) knows a salaried
Admin/Office employee has no hours at all -- the same reason the
"(Admin/Office)" label was added for work_type in the first place.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "empNames roster string: append ', Salaried' for the admin+salary combination",
        """          return rows.map(function(e){ return e.name + ' (' + (e.work_type === 'admin' ? 'Admin/Office' : (e.team || e.defaultTeam || '')) + ')'; }).join(', ');""",
        """          return rows.map(function(e){
            var _teamLabel = e.work_type === 'admin' ? 'Admin/Office' : (e.team || e.defaultTeam || '');
            if (e.work_type === 'admin' && e.pay_type === 'salary') _teamLabel += ', Salaried';
            return e.name + ' (' + _teamLabel + ')';
          }).join(', ');""",
    ),
    (
        "System prompt: explain the Admin/Office+Salaried combination to Claire's own reasoning",
        """    +'An employee shown as "(Admin/Office)" is office staff with no field team -- never include them when a team name is used to mean "everyone on that team" (e.g. "S1 worked 8 to 4 today" means only S1\\'s field members). You can still name an Admin/Office employee directly (e.g. "Linda worked 9 to 5") and use get_employee_hours/edit_employee_hours/batch_edit_employee_hours for them exactly as for anyone else -- their hours just come from manual entries, never GPS.\\n'""",
        """    +'An employee shown as "(Admin/Office)" is office staff with no field team -- never include them when a team name is used to mean "everyone on that team" (e.g. "S1 worked 8 to 4 today" means only S1\\'s field members). You can still name an Admin/Office employee directly (e.g. "Linda worked 9 to 5") and use get_employee_hours/edit_employee_hours/batch_edit_employee_hours for them exactly as for anyone else -- their hours just come from manual entries, never GPS.\\n'
    +'An employee shown as "(Admin/Office, Salaried)" has NO hours tracked at all -- fixed pay, not hourly. get_employee_hours reports "salaried, no hours tracked" for them; edit_employee_hours refuses with a plain message ("X is salaried, so there are no hours to edit"); batch_edit_employee_hours skips them and says so in the preview rather than failing the whole batch. Don\\'t try to work around this by editing their hours a different way -- there is nothing to edit. This never applies to a field (non-Admin/Office) employee, even if they happen to also be salaried.\\n'""",
    ),
]

apply_edits(EDITS)
