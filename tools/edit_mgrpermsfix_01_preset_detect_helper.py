#!/usr/bin/env python3
"""manage-permissions-button-fix -- PART 1. Adds _pentaDescribePreset()
(classifies a saved manager_permissions object against the known
presets, or "Custom"/"Full manager" ) so the Manager Access status line
can show Tom her current preset without opening anything.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = "function _pentaIsOwnerOrAdmin() {"

NEW = """// manage-permissions-button-fix: classifies a saved manager_permissions
// object against the known presets, so the Manager Access status line
// can show "Limited manager" / "Full manager" / "Custom" without
// opening the Permissions panel. An exact key-for-key match (not just
// "looks similar") against a preset's payload -- anything else is
// "Custom" rather than guessing which preset it's closest to.
function _pentaPermsObjectsMatch(a, b) {
  a = a || {}; b = b || {};
  var keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (var i = 0; i < keysA.length; i++) {
    var k = keysA[i];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}
function _pentaDescribePreset(perms) {
  perms = perms || {};
  if (Object.keys(perms).length === 0) return 'Full manager (no restrictions)';
  if (typeof PRESET_LABELS === 'undefined' || typeof PRESET_PERMISSIONS === 'undefined') return 'Custom';
  for (var i = 0; i < PRESET_LABELS.length; i++) {
    var p = PRESET_LABELS[i];
    if (p.disabled) continue;
    var preset = PRESET_PERMISSIONS[p.key];
    // Skip the two presets that are themselves {} -- already handled
    // by the "no restrictions" check above, and would otherwise always
    // match first regardless of what the real preset was.
    if (preset && Object.keys(preset).length === 0) continue;
    if (preset && _pentaPermsObjectsMatch(perms, preset)) return p.label;
  }
  return 'Custom';
}

function _pentaIsOwnerOrAdmin() {"""

EDITS = [
    ("manage-permissions-button-fix: add the current-preset detection helper", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
