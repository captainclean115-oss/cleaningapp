#!/usr/bin/env python3
"""Hours-weekend-days fix -- PART 2, employee portal. The 4 hardcoded
5-day-week Monday-first name lists (salaried view, the main hours
breakdown, the single-day dispute picker, and the weekly dispute day
picker) all extend to the full 7 days, in all 4 languages this app
already supports (en/es/pt/cv) -- "same behavior in manager view and
employee view."
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD1 = """      var daysFullSal = {
        en: ['Monday','Tuesday','Wednesday','Thursday','Friday'],
        es: ['Lunes','Martes','Miércoles','Jueves','Viernes'],
        pt: ['Segunda','Terça','Quarta','Quinta','Sexta'],
        cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta']
      };"""

NEW1 = """      var daysFullSal = {
        en: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
        es: ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'],
        pt: ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'],
        cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta','Sabadu','Dumingu']
      };"""

OLD2 = """  const daysFull = {
    en: ['Monday','Tuesday','Wednesday','Thursday','Friday'],
    es: ['Lunes','Martes','Miércoles','Jueves','Viernes'],
    pt: ['Segunda','Terça','Quarta','Quinta','Sexta'],
    cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta']
  };
  const lunchLabel = { en:'Lunch', es:'Almuerzo', pt:'Almoço', cv:'Almosu' };"""

NEW2 = """  const daysFull = {
    en: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
    es: ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'],
    pt: ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'],
    cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta','Sabadu','Dumingu']
  };
  const lunchLabel = { en:'Lunch', es:'Almuerzo', pt:'Almoço', cv:'Almosu' };"""

OLD3 = """function openHoursDispute(dayIdx, startStr, endStr, lunch) {
  const daysFull = ['Monday','Tuesday','Wednesday','Thursday','Friday'];"""

NEW3 = """function openHoursDispute(dayIdx, startStr, endStr, lunch) {
  const daysFull = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];"""

OLD4 = """  const daysFull = {
    en: ['Monday','Tuesday','Wednesday','Thursday','Friday','Whole Week'],
    es: ['Lunes','Martes','Miércoles','Jueves','Viernes','Toda la semana'],
    pt: ['Segunda','Terça','Quarta','Quinta','Sexta','Semana toda'],
    cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta','Simana inteira']
  };"""

NEW4 = """  const daysFull = {
    en: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','Whole Week'],
    es: ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo','Toda la semana'],
    pt: ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo','Semana toda'],
    cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta','Sabadu','Dumingu','Simana inteira']
  };"""

EDITS = [
    ("Hours-weekend-days fix: salaried portal view day names extend to 7 days", OLD1, NEW1),
    ("Hours-weekend-days fix: renderHoursData day names extend to 7 days", OLD2, NEW2),
    ("Hours-weekend-days fix: openHoursDispute day names extend to 7 days", OLD3, NEW3),
    ("Hours-weekend-days fix: openWeeklyDispute day names extend to 7 days", OLD4, NEW4),
]

if __name__ == "__main__":
    apply_edits(EDITS)
