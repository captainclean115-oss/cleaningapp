#!/usr/bin/env python3
"""Hours-week-nav fix -- employee portal Hours screen.

Shares the manager Hours tab's bug category: portalWeekNav() mutates
_portalWeekOffset synchronously, but renderHours() had NO in-flight
guard at all -- rapid taps (or the swipe gesture) launch overlapping
published_employee_hours fetches, and each one reads the live
_portalWeekOffset global AFTER its own await, not a value captured at
the time the tap happened. Whichever fetch finishes last wins the
paint, even if it was requested FIRST and is now stale -- a real
"ignore stale responses" gap the manager side didn't have (it had the
opposite problem: an in-flight guard that dropped taps entirely).

Also fixes a second, separate bug surfaced while threading the offset
through: renderHoursData() always called getPortalWeekDates() with NO
argument, which defaults to THIS week regardless of which week was
actually being viewed -- so the per-day "is this today" highlight and
the extra-task lookup (keyed by date string) used the wrong week's
dates whenever viewing anything other than the current week.

Fix: renderHours() is renamed to _renderHoursInnerImpl and wrapped by
a new renderHours() using the exact same in-flight/rerun pattern as
the manager's loadWeekHours() -- never two overlapping fetches, but a
tap landing mid-flight is never dropped, and every existing
fire-and-forget or awaited caller keeps the same name/behavior.
_renderHoursInnerImpl captures _portalWeekOffset once at the top and
threads that value through the label, the forward-button state, and
renderHoursData instead of re-reading the live global or defaulting
to the current week.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD_STATE = """var _portalWeekOffset = 0;

function portalWeekNav(dir) {
  if (dir > 0 && _portalWeekOffset >= 0) return; // can't go future
  _portalWeekOffset += dir;
  if (_portalWeekOffset > 0) _portalWeekOffset = 0;
  renderHours();
}"""

NEW_STATE = """var _portalWeekOffset = 0;

// Hours-week-nav fix: the one shared label-text formula, used both for
// instant tap feedback (portalWeekNav, below) and inside
// _renderHoursInnerImpl once the real data is in.
function _portalWeekLabelText(offset) {
  var lang = currentLang || 'en';
  if (offset === 0) return t('thisWeek');
  if (offset === -1) return {en:'Last Week',es:'Semana pasada',pt:'Semana passada',cv:'Simana pasadu'}[lang] || 'Last Week';
  return Math.abs(offset) + ' ' + ({en:'weeks ago',es:'semanas atrás',pt:'semanas atrás',cv:'simanas atras'}[lang] || 'weeks ago');
}

// Hours-week-nav fix: the label, the forward-button state, and a
// loading placeholder now update INSTANTLY on tap (and on swipe --
// same handler), synchronously, before the published-hours fetch even
// starts -- same fix as the manager Hours tab's hoursWeekMove(). The
// actual fetch/render still happens inside renderHours(), which is now
// safe against repeated fast taps (see that function's own comment).
function portalWeekNav(dir) {
  if (dir > 0 && _portalWeekOffset >= 0) return; // can't go future
  _portalWeekOffset += dir;
  if (_portalWeekOffset > 0) _portalWeekOffset = 0;
  var labelEl = document.getElementById('week-label');
  if (labelEl) labelEl.textContent = _portalWeekLabelText(_portalWeekOffset);
  var fwdBtn = document.getElementById('portal-week-fwd');
  if (fwdBtn) {
    fwdBtn.style.opacity = _portalWeekOffset >= 0 ? '0.3' : '1';
    fwdBtn.style.pointerEvents = _portalWeekOffset >= 0 ? 'none' : 'auto';
  }
  var breakdownEl = document.getElementById('hours-breakdown');
  if (breakdownEl) breakdownEl.innerHTML = '<div style="color:var(--muted);text-align:center;padding:16px 0;font-size:13px">Loading your hours...</div>';
  renderHours();
}"""

OLD_RENDER_HOURS_DEF = """async function renderHours() {
  // PR #134 -- same PentaAssignments/PentaEmployees hydration race"""

NEW_RENDER_HOURS_DEF = """var _portalHoursLoadInFlight = false;
var _portalHoursLoadInFlightPromise = null;
// Hours-week-nav fix: same rerun-on-change pattern as the manager's
// loadWeekHours -- never two overlapping published-hours fetches
// racing each other's DOM paint (whichever finished last used to win,
// even if it was requested first and had gone stale), but a tap
// landing mid-flight is never dropped: once the current fetch
// finishes, if _portalWeekOffset no longer matches what was actually
// rendered, it reruns immediately, under the SAME promise every
// existing caller (fire-and-forget or the realtime callback) already
// relies on by name.
async function renderHours() {
  if (_portalHoursLoadInFlight) return _portalHoursLoadInFlightPromise;
  _portalHoursLoadInFlight = true;
  _portalHoursLoadInFlightPromise = (async function () {
    try {
      do {
        await _renderHoursInnerImpl();
      } while (_portalWeekOffset !== _portalHoursLastAttemptedOffset);
    } finally {
      _portalHoursLoadInFlight = false;
      _portalHoursLoadInFlightPromise = null;
    }
  })();
  return _portalHoursLoadInFlightPromise;
}

var _portalHoursLastAttemptedOffset = null;
async function _renderHoursInnerImpl() {
  // PR #134 -- same PentaAssignments/PentaEmployees hydration race"""

OLD_RENDER_HOURS_MID = """  var days = getPortalWeekDates(_portalWeekOffset);
  var mon = days[0];
  var fri = days[days.length - 1];
  var lang = currentLang || 'en';

  // Update header
  if (_portalWeekOffset === 0) {
    document.getElementById('week-label').textContent = t('thisWeek');
  } else if (_portalWeekOffset === -1) {
    document.getElementById('week-label').textContent = {en:'Last Week',es:'Semana pasada',pt:'Semana passada',cv:'Simana pasadu'}[lang] || 'Last Week';
  } else {
    document.getElementById('week-label').textContent = Math.abs(_portalWeekOffset) + ' ' + ({en:'weeks ago',es:'semanas atrás',pt:'semanas atrás',cv:'simanas atras'}[lang] || 'weeks ago');
  }
  var datesEl = document.getElementById('portal-week-dates');
  if (datesEl) datesEl.textContent = mon.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' + fri.toLocaleDateString('en-US',{month:'short',day:'numeric'});

  // Disable forward button if on current week
  var fwdBtn = document.getElementById('portal-week-fwd');
  if (fwdBtn) {
    fwdBtn.style.opacity = _portalWeekOffset >= 0 ? '0.3' : '1';
    fwdBtn.style.pointerEvents = _portalWeekOffset >= 0 ? 'none' : 'auto';
  }"""

NEW_RENDER_HOURS_MID = """  // Hours-week-nav fix: captured ONCE here and used for every read in
  // this function from this point on (days, the label, the
  // forward-button state, renderHoursData below) instead of the live
  // global, which can change mid-flight if another tap or swipe lands
  // while this fetch is still pending.
  var _myPortalOffset = _portalWeekOffset;
  _portalHoursLastAttemptedOffset = _myPortalOffset;
  var days = getPortalWeekDates(_myPortalOffset);
  var mon = days[0];
  var fri = days[days.length - 1];

  // Update header -- portalWeekNav() already set this instantly on
  // tap/swipe; this just re-confirms it once the real data is in.
  var _labelEl = document.getElementById('week-label');
  if (_labelEl) _labelEl.textContent = _portalWeekLabelText(_myPortalOffset);
  var datesEl = document.getElementById('portal-week-dates');
  if (datesEl) datesEl.textContent = mon.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' + fri.toLocaleDateString('en-US',{month:'short',day:'numeric'});

  // Disable forward button if on current week
  var fwdBtn = document.getElementById('portal-week-fwd');
  if (fwdBtn) {
    fwdBtn.style.opacity = _myPortalOffset >= 0 ? '0.3' : '1';
    fwdBtn.style.pointerEvents = _myPortalOffset >= 0 ? 'none' : 'auto';
  }"""

OLD_RENDERDATA_CALL_1 = """    } catch (e) {
      console.error('[portal hours] Salaried view failed to render', e);
      var breakdownElErr = document.getElementById('hours-breakdown');
      if (breakdownElErr) breakdownElErr.innerHTML = '<div style="color:var(--red);text-align:center;padding:16px 0;font-size:13px">Could not load your status. Please reload.</div>';
    }
    return;
  }"""

NEW_RENDERDATA_CALL_1 = """    } catch (e) {
      console.error('[portal hours] Salaried view failed to render', e);
      var breakdownElErr = document.getElementById('hours-breakdown');
      if (breakdownElErr) breakdownElErr.innerHTML = '<div style="color:var(--red);text-align:center;padding:16px 0;font-size:13px">Could not load your status. Please reload.</div>';
    }
    return;
  }
  // (Salaried view never reaches renderHoursData -- no hours grid.)"""

OLD_RENDERDATA_CALL_2 = """      composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);
    } catch (e) {
      console.error('[portal hours] Admin/Office hours failed to load', e);
    }
    renderHoursData(composite);
    return;
  }"""

NEW_RENDERDATA_CALL_2 = """      composite.total = composite.days.reduce(function (s, h) { return s + (h || 0); }, 0);
    } catch (e) {
      console.error('[portal hours] Admin/Office hours failed to load', e);
    }
    renderHoursData(composite, _myPortalOffset);
    return;
  }"""

OLD_RENDERDATA_CALL_3 = """  renderHoursData(composite);
}

// Hours-weekend-days fix: delegates to getWeekDates (the Hours tab's"""

NEW_RENDERDATA_CALL_3 = """  renderHoursData(composite, _myPortalOffset);
}

// Hours-weekend-days fix: delegates to getWeekDates (the Hours tab's"""

OLD_RENDERHOURSDATA_DEF = """function renderHoursData(data) {
  const daysFull = {
    en: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
    es: ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'],
    pt: ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'],
    cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta','Sabadu','Dumingu']
  };
  const lunchLabel = { en:'Lunch', es:'Almuerzo', pt:'Almoço', cv:'Almosu' };
  const disputeLabel = { en:'Does this look right?', es:'¿Se ve correcto?', pt:'Está correto?', cv:'Sta bon?' };

  let totalHrs = 0;

  // Load extra tasks for this employee
  var portalDays = getPortalWeekDates();"""

NEW_RENDERHOURSDATA_DEF = """function renderHoursData(data, offset) {
  const daysFull = {
    en: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
    es: ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'],
    pt: ['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'],
    cv: ['Sigunda','Tersa','Kuarta','Kinta','Sesta','Sabadu','Dumingu']
  };
  const lunchLabel = { en:'Lunch', es:'Almuerzo', pt:'Almoço', cv:'Almosu' };
  const disputeLabel = { en:'Does this look right?', es:'¿Se ve correcto?', pt:'Está correto?', cv:'Sta bon?' };

  let totalHrs = 0;

  // Hours-week-nav fix: an explicit offset (passed by renderHours,
  // captured before its own fetch) always wins over the live global --
  // this used to default to THIS week unconditionally (getPortalWeekDates()
  // with no argument), so the "is this today" highlight and the
  // extra-task lookup below used the wrong week's dates whenever
  // viewing anything other than the current week.
  var portalDays = getPortalWeekDates(offset);"""

EDITS = [
    ("Hours-week-nav fix: portalWeekNav updates the label/loading state instantly", OLD_STATE, NEW_STATE),
    ("Hours-week-nav fix: renderHours wraps _renderHoursInnerImpl with a rerun-on-change loop", OLD_RENDER_HOURS_DEF, NEW_RENDER_HOURS_DEF),
    ("Hours-week-nav fix: _renderHoursInnerImpl captures the offset once", OLD_RENDER_HOURS_MID, NEW_RENDER_HOURS_MID),
    ("Hours-week-nav fix: note the Salaried branch never reaches renderHoursData", OLD_RENDERDATA_CALL_1, NEW_RENDERDATA_CALL_1),
    ("Hours-week-nav fix: Admin/Office branch passes the captured offset to renderHoursData", OLD_RENDERDATA_CALL_2, NEW_RENDERDATA_CALL_2),
    ("Hours-week-nav fix: field-employee branch passes the captured offset to renderHoursData", OLD_RENDERDATA_CALL_3, NEW_RENDERDATA_CALL_3),
    ("Hours-week-nav fix: renderHoursData uses the passed-in offset instead of defaulting to this week", OLD_RENDERHOURSDATA_DEF, NEW_RENDERHOURSDATA_DEF),
]

if __name__ == "__main__":
    apply_edits(EDITS)
