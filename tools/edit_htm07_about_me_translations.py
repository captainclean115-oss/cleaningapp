#!/usr/bin/env python3
"""Hire-transfer-missing-fields fix -- PART 7. New translation keys
(aboutMeAddress, aboutMeEmergencyContact) for the 2 new About Me rows,
one per supported language (en/es/pt/cv), matching this dictionary's
existing per-language block layout exactly.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

EDITS = [
    (
        "Hire-transfer-missing-fields fix: English About Me translations",
        "    aboutMeVacation: 'Vacation / PTO',\n    aboutMeNotAvailable: \"This isn't available yet.\",",
        "    aboutMeVacation: 'Vacation / PTO',\n    aboutMeAddress: 'Address',\n    aboutMeEmergencyContact: 'Emergency Contact',\n    aboutMeNotAvailable: \"This isn't available yet.\",",
    ),
    (
        "Hire-transfer-missing-fields fix: Spanish About Me translations",
        "    aboutMeVacation: 'Vacaciones / PTO',\n    aboutMeNotAvailable: 'Esto no está disponible todavía.',",
        "    aboutMeVacation: 'Vacaciones / PTO',\n    aboutMeAddress: 'Dirección',\n    aboutMeEmergencyContact: 'Contacto de Emergencia',\n    aboutMeNotAvailable: 'Esto no está disponible todavía.',",
    ),
    (
        "Hire-transfer-missing-fields fix: Portuguese About Me translations",
        "    aboutMeVacation: 'Férias / PTO',\n    aboutMeNotAvailable: 'Isso ainda não está disponível.',",
        "    aboutMeVacation: 'Férias / PTO',\n    aboutMeAddress: 'Endereço',\n    aboutMeEmergencyContact: 'Contato de Emergência',\n    aboutMeNotAvailable: 'Isso ainda não está disponível.',",
    ),
    (
        "Hire-transfer-missing-fields fix: Kriolu About Me translations",
        "    aboutMeVacation: 'Féria / PTO',\n    aboutMeNotAvailable: 'Kel li ka ta disponivel ainda.',",
        "    aboutMeVacation: 'Féria / PTO',\n    aboutMeAddress: 'Endereçu',\n    aboutMeEmergencyContact: 'Kontaktu di Emerjénsia',\n    aboutMeNotAvailable: 'Kel li ka ta disponivel ainda.',",
    ),
]

if __name__ == "__main__":
    apply_edits(EDITS)
