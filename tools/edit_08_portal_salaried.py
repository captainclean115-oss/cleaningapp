#!/usr/bin/env python3
"""Edit 8/N -- salaried Admin/Office feature.

Employee portal renderHours(): a salaried admin employee gets a
dedicated "Salaried" view -- no hours, no clock, no weekly total, no
team/vehicle language at all (not even the Admin/Office hourly
branch's day-by-day blank/hours grid). OFF/vacation status still shows
per day, since that's genuinely useful and completely independent of
pay type.
"""
import sys
sys.path.insert(0, ".")
from tools._apply_edits import apply_edits

EDITS = [
    (
        "renderHours(): salaried branch, checked BEFORE the hourly Admin/Office branch",
        """  if (currentEmployee && currentEmployee.work_type === 'admin') {
    try {
      days.forEach(function (d, i) {
        var dk = dateKey(d);
        var offInfo = _adminEmpDayOff(currentEmployee.id, dk);
        if (offInfo) {
          composite.status[i] = { type: offInfo.status_type || 'off', label: offInfo.label };
          return;
        }
        var override = getEmpHours(currentEmployee.id, dk);
        if (!override) return; // nothing on file -- leave this day blank
        composite.days[i] = override.hours || 0;
        if (override.start) {
          var sp = override.start.split(':');
          var sd = new Date(d); sd.setHours(parseInt(sp[0]), parseInt(sp[1]), 0, 0);
          composite.starts[i] = sd.toISOString();
        }
        if (override.end) {
          var ep = override.end.split(':');
          var ed = new Date(d); ed.setHours(parseInt(ep[0]), parseInt(ep[1]), 0, 0);
          composite.ends[i] = ed.toISOString();
        }
      });
      composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);
    } catch (e) {
      console.error('[portal hours] Admin/Office hours failed to load', e);
    }
    renderHoursData(composite);
    return;
  }""",
        """  // Salaried Admin/Office (follow-up to migration 113). Checked BEFORE
  // the plain (hourly) Admin/Office branch right below -- a salaried
  // employee gets a dedicated view with NO hours/clock/weekly total/
  // team/vehicle language at all, not the hourly branch's day-by-day
  // blank-or-hours grid. OFF/vacation status still shows -- that's
  // genuinely useful and completely independent of pay type.
  if (currentEmployee && typeof isSalariedAdmin === 'function' && isSalariedAdmin(currentEmployee)) {
    try {
      var _salDayOff = [];
      days.forEach(function (d, i) {
        var dk = dateKey(d);
        var offInfo = _adminEmpDayOff(currentEmployee.id, dk);
        _salDayOff[i] = offInfo ? offInfo.label : null;
      });
      var daysFullSal = {
        en: ['Monday','Tuesday','Wednesday','Thursday','Friday'],
        es: ['Lunes','Martes','Miércoles','Jueves','Viernes'],
        pt: ['Segunda','Terça','Quarta','Quinta','Sexta'],
        cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta']
      };
      var salLabel = { en: 'Salaried', es: 'Asalariado/a', pt: 'Assalariado(a)', cv: 'Salariadu' }[currentLang] || 'Salaried';
      var salSub = { en: 'No hours are tracked for salaried staff.', es: 'No se registran horas para el personal asalariado.', pt: 'Não há controle de horas para funcionários assalariados.', cv: 'Ka ten ora ta rejistradu pa pesoal salariadu.' }[currentLang] || 'No hours are tracked for salaried staff.';
      var totalLabelEl = document.getElementById('total-label');
      if (totalLabelEl) totalLabelEl.textContent = salLabel;
      var totalHrsEl = document.getElementById('total-hrs');
      if (totalHrsEl) totalHrsEl.textContent = '—';
      var breakdownEl = document.getElementById('hours-breakdown');
      if (breakdownEl) {
        var salHtml = '<div style="text-align:center;padding:16px 0 4px;color:#fbbf24;font-weight:700;font-size:16px">' + salLabel + '</div>'
          + '<div style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:16px">' + salSub + '</div>';
        salHtml += (daysFullSal[currentLang] || daysFullSal.en).map(function (dayName, i) {
          var offLbl = _salDayOff[i];
          return '<div class="hours-row"><div style="flex:1"><div class="hours-day">' + dayName + '</div>'
            + (offLbl ? '<div class="hours-time" style="color:var(--muted)">' + offLbl + '</div>' : '') + '</div></div>';
        }).join('');
        breakdownEl.innerHTML = salHtml;
      }
    } catch (e) {
      console.error('[portal hours] Salaried view failed to render', e);
      var breakdownElErr = document.getElementById('hours-breakdown');
      if (breakdownElErr) breakdownElErr.innerHTML = '<div style="color:var(--red);text-align:center;padding:16px 0;font-size:13px">Could not load your status. Please reload.</div>';
    }
    return;
  }

  if (currentEmployee && currentEmployee.work_type === 'admin') {
    try {
      days.forEach(function (d, i) {
        var dk = dateKey(d);
        var offInfo = _adminEmpDayOff(currentEmployee.id, dk);
        if (offInfo) {
          composite.status[i] = { type: offInfo.status_type || 'off', label: offInfo.label };
          return;
        }
        var override = getEmpHours(currentEmployee.id, dk);
        if (!override) return; // nothing on file -- leave this day blank
        composite.days[i] = override.hours || 0;
        if (override.start) {
          var sp = override.start.split(':');
          var sd = new Date(d); sd.setHours(parseInt(sp[0]), parseInt(sp[1]), 0, 0);
          composite.starts[i] = sd.toISOString();
        }
        if (override.end) {
          var ep = override.end.split(':');
          var ed = new Date(d); ed.setHours(parseInt(ep[0]), parseInt(ep[1]), 0, 0);
          composite.ends[i] = ed.toISOString();
        }
      });
      composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);
    } catch (e) {
      console.error('[portal hours] Admin/Office hours failed to load', e);
    }
    renderHoursData(composite);
    return;
  }""",
    ),
]

apply_edits(EDITS)
