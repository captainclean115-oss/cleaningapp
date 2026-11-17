#!/usr/bin/env python3
"""Hire-transfer-missing-fields fix -- PART 6. renderPortalAboutMe
shows the address + emergency contact get_my_about_me() (migration
125) now returns -- the employee's own portal profile screen, so she
can check her own address/emergency contact are on file correctly,
same reasoning as the migration's own comment.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """    body.innerHTML = ''
      + _portalAboutMeRow(t('accountNameLabel'), d.name)
      + _portalAboutMeRow(t('aboutMeRole'), d.team_label)
      + _portalAboutMeRow(t('aboutMeTenure'), d.tenure_text)
      + payRow
      + _portalAboutMeRow(t('aboutMeVacation'), d.vacation_text);
  } catch (e) { console.error('[portal about-me] render failed', e); }
}"""

NEW = """    // Hire-transfer-missing-fields fix: her own address + emergency
    // contact (migration 125) -- blank rows just never render, same
    // "only show what's actually on file" convention as payRow above.
    var addressParts = [d.address, d.city, d.state].filter(Boolean).join(', ') + (d.zip ? ' ' + d.zip : '');
    var addressRow = addressParts.trim() ? _portalAboutMeRow(t('aboutMeAddress'), addressParts.trim()) : '';
    var emName = (d.emergency_contact_name || '').trim();
    var emPhone = (d.emergency_contact_phone || '').trim();
    var emRel = (d.emergency_contact_relationship || '').trim();
    var emText = [emName, emRel].filter(Boolean).join(' — ') + (emPhone ? (emName || emRel ? ', ' : '') + emPhone : '');
    var emergencyRow = emText.trim() ? _portalAboutMeRow(t('aboutMeEmergencyContact'), emText.trim()) : '';
    body.innerHTML = ''
      + _portalAboutMeRow(t('accountNameLabel'), d.name)
      + _portalAboutMeRow(t('aboutMeRole'), d.team_label)
      + _portalAboutMeRow(t('aboutMeTenure'), d.tenure_text)
      + payRow
      + _portalAboutMeRow(t('aboutMeVacation'), d.vacation_text)
      + addressRow
      + emergencyRow;
  } catch (e) { console.error('[portal about-me] render failed', e); }
}"""

EDITS = [
    ("Hire-transfer-missing-fields fix: About Me shows address + emergency contact", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
