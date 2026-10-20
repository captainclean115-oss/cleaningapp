#!/usr/bin/env python3
"""Published Hours feature. Claire's edit_employee_hours writes a manual
override but never calls loadWeekHours() at all (only a conditional
_writeWeekHoursCache for the OLD manager-only cache relay, left
untouched here). Without an explicit republish, a Claire-written hours
edit would never reach the employee-facing published table until some
unrelated later loadWeekHours() run. Not awaited -- Claire's reply
shouldn't wait on a cross-week recompute+publish cycle.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    } catch (e) {}
    var dayL3 = new Date(ehDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});"""

NEW = """    } catch (e) {}
    // Published Hours: this write never goes through loadWeekHours() on
    // its own -- explicitly republish so it reaches the employee's
    // published table without waiting on an unrelated later refresh.
    if (typeof _republishAfterHoursEdit === 'function') {
      _republishAfterHoursEdit(ehDate).catch(function (e) { console.error('[publish] Claire edit_employee_hours republish failed', e); });
    }
    var dayL3 = new Date(ehDate+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});"""

EDITS = [("Claire edit_employee_hours: republish after a successful write", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
