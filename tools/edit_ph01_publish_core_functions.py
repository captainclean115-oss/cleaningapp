#!/usr/bin/env python3
"""Published Hours feature. Core publish machinery: resolveEmployeeDayHours
stays the ONLY place hours are ever calculated -- everything here just
writes out what that function (or, for Admin/Office, the same getEmpHours/
_adminEmpDayOff the manager's own portal-admin branch already reads)
already resolved, into published_employee_hours (migrations/114).

Inserted right after resolveEmployeeDayHours's own closing brace, before
renderHoursTable -- same neighborhood as the function it depends on.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """function renderHoursTable(days, dayNames) {"""

NEW = """// ═══════════════════════════════════════════════════════════════════════
// Published Hours (migrations/114_published_employee_hours.sql).
//
// The employee portal no longer computes anything -- it reads ONLY this
// table, filtered by RLS to the logged-in employee's own employee_id. No
// Geotab call, no whole-business manual_hour_overrides/daily_assignments
// fetch, ever reaches a field employee's own phone again (confirmed
// during the portal-hours-match-manager PR review that those WERE
// reaching it, even though only the employee's own slice was rendered --
// the full business-wide fetch itself was the exposure, not the render).
//
// publishWeekHours() never computes a second copy of anything: it reads
// whatever resolveEmployeeDayHours() (field employees) or getEmpHours/
// _adminEmpDayOff (Admin/Office, same functions the admin portal branch
// already reads) already resolved from weekHoursData/empHoursMapData --
// passed in explicitly by the caller, exactly like resolveEmployeeDayHours
// itself, so this can never silently read a different week than the one
// that was actually just computed.
function _toInstant(dayDate, hhmm) {
  if (!hhmm) return null;
  var p = hhmm.split(':');
  var d = new Date(dayDate);
  d.setHours(parseInt(p[0], 10), parseInt(p[1], 10), 0, 0);
  return d.toISOString();
}

function _isUuidLike(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Reverse of getWeekDates(offset): which offset (relative to "this
// week" = 0) contains dateStr. Used only by _republishAfterHoursEdit,
// to realign the manager's global hoursWeekOffset to whatever week an
// edit (Claire, Team Hours modal) actually landed in before recomputing.
function _weekOffsetForDate(dateStr) {
  var d = new Date(dateStr + 'T00:00:00');
  var day = d.getDay();
  var mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  mon.setHours(0, 0, 0, 0);
  var thisMon = getWeekDates(0)[0];
  return Math.round((mon - thisMon) / (7 * 86400000));
}

async function publishWeekHours(days, weekHoursData, empHoursMapData) {
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  var bid = (window.PentaTenant && window.PentaTenant.current && window.PentaTenant.current()) || null;
  if (!sb || !bid) throw new Error('Not connected -- cannot publish hours.');

  var currentUserId = (window.PentaAuth && window.PentaAuth.session && window.PentaAuth.session.user && window.PentaAuth.session.user.id) || null;
  if (!currentUserId) {
    try { var ures = await sb.auth.getUser(); currentUserId = ures && ures.data && ures.data.user && ures.data.user.id; } catch (e) {}
  }

  var todayKey = dateKey(new Date());
  var now = new Date();
  var candidates = [];
  var skipped = [];

  days.forEach(function (d, dayIdx) {
    if (d > now) return; // never publish a day that hasn't happened yet
    var dk = dateKey(d);
    var roster = getUnifiedRoster(dk);
    roster.forEach(function (emp) {
      var empUuid = emp.uuid || emp.id;
      if (!_isUuidLike(empUuid)) { skipped.push({ emp: emp.name, date: dk, reason: 'no resolvable uuid' }); return; }
      var base = { business_id: bid, employee_id: empUuid, work_date: dk, published_by: currentUserId };

      if (typeof isSalariedAdmin === 'function' && isSalariedAdmin(emp)) {
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: null, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: 'salaried', source: null }) });
        return;
      }

      if (emp.work_type === 'admin') {
        var offInfo = _adminEmpDayOff(emp.id, dk);
        if (offInfo) {
          candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: 0, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: (offInfo.status_type === 'vacation' ? 'vacation' : 'off'), source: null }) });
          return;
        }
        var override = getEmpHours(emp.id, dk);
        if (!override) { if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'no manual hours on file' }); return; }
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, {
          hours: override.hours || 0, start_time: _toInstant(d, override.start), end_time: _toInstant(d, override.end),
          lunch_minutes: override.lunch || 0, team_label: null, status: 'worked', source: 'manual'
        }) });
        return;
      }

      // Field employee -- the exact function renderHoursTable itself reads.
      var rd = resolveEmployeeDayHours(emp.id, d, dayIdx, weekHoursData, empHoursMapData);
      if (rd.isOff) {
        var fOffInfo = (typeof getEmployeeDayOffInfo === 'function') ? getEmployeeDayOffInfo(emp.id, dk) : null;
        candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, { hours: 0, start_time: null, end_time: null, lunch_minutes: null, team_label: null, status: (fOffInfo && fOffInfo.status_type === 'vacation' ? 'vacation' : 'off'), source: null }) });
        return;
      }
      // An unresolved ambiguous zero (no override, no personal GPS/clock
      // cell, team's own source is time_entries) means "no data yet", not
      // a verified zero-hour day -- never publish a fake zero. A REAL
      // override of 0 is a deliberate manager entry and still publishes
      // (isOverride is what tells the two apart).
      if (rd.hours === 0 && !rd.isOverride) {
        if (dk !== todayKey) skipped.push({ emp: emp.name, date: dk, reason: 'unresolved -- no GPS/clock data yet' });
        return;
      }
      candidates.push({ key: empUuid + '|' + dk, row: Object.assign({}, base, {
        hours: rd.hours, start_time: rd.startDate ? rd.startDate.toISOString() : null, end_time: rd.endDate ? rd.endDate.toISOString() : null,
        lunch_minutes: rd.lunchMin || 0, team_label: rd.dayTeam || null, status: 'worked', source: rd.isOverride ? 'override' : 'gps'
      }) });
    });
  });

  if (!candidates.length) return { published: 0, skipped: skipped.length, skippedDetail: skipped };

  // Diff against what's already published: only changed/new rows are
  // written, so published_at (the employee-visible "Updated" time) only
  // moves when a value actually changed -- not on every routine 60s Live
  // recompute, which would otherwise bump it constantly for no reason.
  var mon = dateKey(days[0]), fri = dateKey(days[days.length - 1]);
  var existingRes = await sb.from('published_employee_hours')
    .select('employee_id, work_date, hours, start_time, end_time, lunch_minutes, team_label, status, source')
    .eq('business_id', bid).gte('work_date', mon).lte('work_date', fri);
  if (existingRes.error) throw new Error('Could not read current published hours before publishing: ' + existingRes.error.message);
  var existingByKey = {};
  (existingRes.data || []).forEach(function (r) { existingByKey[r.employee_id + '|' + r.work_date] = r; });

  function _sameRow(a, b) {
    return a.hours == b.hours && a.start_time == b.start_time && a.end_time == b.end_time
      && a.lunch_minutes == b.lunch_minutes && a.team_label == b.team_label && a.status == b.status && a.source == b.source;
  }

  var toWrite = candidates.filter(function (c) {
    var existing = existingByKey[c.key];
    return !existing || !_sameRow(existing, c.row);
  }).map(function (c) { return c.row; });

  if (!toWrite.length) return { published: 0, skipped: skipped.length, skippedDetail: skipped, unchanged: candidates.length };

  var CHUNK = 200;
  var publishedCount = 0;
  for (var i = 0; i < toWrite.length; i += CHUNK) {
    var chunk = toWrite.slice(i, i + CHUNK);
    var res = await sb.from('published_employee_hours').upsert(chunk, { onConflict: 'business_id,employee_id,work_date' });
    if (res.error) throw new Error('Publish failed partway through (' + publishedCount + '/' + toWrite.length + ' rows written): ' + res.error.message);
    publishedCount += chunk.length;
  }
  return { published: publishedCount, skipped: skipped.length, skippedDetail: skipped };
}

function _updatePublishIndicator(weekKey, info) {
  var el = document.getElementById('hours-published-indicator');
  if (!el) return;
  if (info && info.error) { el.style.color = 'var(--red)'; el.textContent = 'Could not publish to employees.'; return; }
  if (info && info.backfill) { el.style.color = 'var(--muted)'; el.textContent = info.backfill; return; }
  el.style.color = 'var(--muted)';
  el.textContent = 'Published to employees ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    + (info && typeof info.count === 'number' ? ' (' + info.count + (info.count === 1 ? ' day' : ' days') + ' updated)' : '');
}

var _publishDebounceTimers = {};
// Debounced so several rapid edits in the same week (a Sunday payroll
// batch via Claire, a manager clicking through several Team Hours
// edits) collapse into one write instead of one upsert per edit.
function _schedulePublishWeekHours(days, weekHoursData, empHoursMapData) {
  try {
    var weekKey = dateKey(days[0]);
    if (_publishDebounceTimers[weekKey]) clearTimeout(_publishDebounceTimers[weekKey]);
    _publishDebounceTimers[weekKey] = setTimeout(function () {
      delete _publishDebounceTimers[weekKey];
      publishWeekHours(days, weekHoursData, empHoursMapData)
        .then(function (result) {
          // Only touch the visible indicator if this week is still the
          // one on screen -- an auto-publish for a week the manager
          // navigated away from shouldn't rewrite her current view.
          if (typeof hoursWeekOffset !== 'undefined' && dateKey(getWeekDates(hoursWeekOffset)[0]) === weekKey) {
            _updatePublishIndicator(weekKey, { ok: true, count: result.published });
          }
        })
        .catch(function (e) {
          console.error('[publish] auto-publish failed for week', weekKey, e);
          if (typeof hoursWeekOffset !== 'undefined' && dateKey(getWeekDates(hoursWeekOffset)[0]) === weekKey) {
            _updatePublishIndicator(weekKey, { error: true });
          }
        });
    }, 1500);
  } catch (e) { console.warn('[publish] schedule failed', e); }
}

// Write paths that write a manual_hour_overrides row WITHOUT already
// calling loadWeekHours() unconditionally afterward (Claire's tools, and
// the Team Hours modal's own refresh, previously gated on the Live tab
// being the active view) call this instead, so the automatic publish
// hook at the tail of _loadWeekHoursInner (which ALWAYS runs on every
// loadWeekHours() call, from any caller) actually fires for the correct
// week. Accepts one date or an array -- a Claire batch touching several
// dates in the same week republishes that week exactly once.
async function _republishAfterHoursEdit(dateStrs) {
  var list = Array.isArray(dateStrs) ? dateStrs : [dateStrs];
  list = list.filter(Boolean);
  if (!list.length || typeof hoursWeekOffset === 'undefined') return;
  try {
    var offsets = {};
    list.forEach(function (ds) { offsets[_weekOffsetForDate(ds)] = true; });
    var savedOffset = hoursWeekOffset;
    var gv = document.getElementById('gps-view');
    var wasActive = gv && gv.classList.contains('active');
    var touchedOther = false;
    for (var off in offsets) {
      var numOff = Number(off);
      hoursWeekOffset = numOff;
      await loadWeekHours();
      if (numOff !== savedOffset) touchedOther = true;
    }
    hoursWeekOffset = savedOffset;
    if (touchedOther && wasActive) await loadWeekHours(); // restore the manager's own on-screen week
  } catch (e) { console.error('[publish] republish-after-edit failed', e); }
}

// Manager-facing "Publish now" button -- publishes the currently-viewed
// week immediately instead of waiting for the debounce.
async function publishWeekHoursNow() {
  var btn = document.getElementById('hours-publish-now-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  try {
    if (typeof weekHours === 'undefined' || !Object.keys(weekHours).length) {
      await loadWeekHours();
    }
    var days = getWeekDates(hoursWeekOffset);
    var result = await publishWeekHours(days, weekHours, window._empHoursMap);
    _updatePublishIndicator(dateKey(days[0]), { ok: true, count: result.published });
  } catch (e) {
    console.error('[publish] Publish now failed', e);
    alert('Hours calculated but could not be published to employees: ' + (e && e.message || 'unknown error'));
    _updatePublishIndicator(null, { error: true });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Publish now'; }
  }
}

// Manager-facing "Publish last 4 weeks" backfill button. Built per spec
// but NOT run by this patch -- Tom runs it himself when ready. Sequential
// (one week at a time), skips a failed week rather than aborting the
// whole backfill, restores the manager's own on-screen week afterward.
async function publishLast4Weeks() {
  if (!confirm('Publish hours to employees for the last 4 completed weeks? This does not change any manager-side numbers.')) return;
  var savedOffset = (typeof hoursWeekOffset !== 'undefined') ? hoursWeekOffset : 0;
  var results = [];
  for (var w = -4; w <= -1; w++) {
    _updatePublishIndicator(null, { backfill: 'Publishing week ' + (w + 5) + ' of 4…' });
    try {
      hoursWeekOffset = w;
      await loadWeekHours();
      var days = getWeekDates(w);
      var result = await publishWeekHours(days, weekHours, window._empHoursMap);
      results.push({ week: dateKey(days[0]), ok: true, published: result.published, skipped: result.skipped });
    } catch (e) {
      console.error('[publish] backfill week offset ' + w + ' failed', e);
      results.push({ week: 'week offset ' + w, ok: false, error: e && e.message });
    }
  }
  hoursWeekOffset = savedOffset;
  try { await loadWeekHours(); } catch (e) {}
  _updatePublishIndicator(dateKey(getWeekDates(savedOffset)[0]), { ok: true, count: 0 });
  alert('Backfill done:\\n' + results.map(function (r) {
    return r.week + ': ' + (r.ok ? (r.published + ' published, ' + r.skipped + ' skipped') : ('FAILED -- ' + r.error));
  }).join('\\n'));
}

function renderHoursTable(days, dayNames) {"""

EDITS = [("Published Hours: insert core publish functions before renderHoursTable", OLD, NEW)]

if __name__ == "__main__":
    apply_edits(EDITS)
