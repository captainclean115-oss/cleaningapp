// =====================================================================
// Sprint 10 Phase 2.5 — rescue any local jobs that didn't make it to
// Supabase during the Phase 2 batch insert.
//
// Tom found two seeds (seed_433, seed_436) in localStorage but not in
// Supabase after Phase 2 migrated 2202/2204 cleanly. Cause unknown —
// likely a transient PostgREST hiccup on a single chunk. This script
// scans for ANY gaps (not just the two known ones) so we don't have
// to chase missing IDs manually.
//
// HOW TO RUN:
//   1. Open the manager app on the device whose localStorage holds the
//      canonical data. Sign in. Wait for home to load.
//   2. Open DevTools console.
//   3. Paste this entire file. Press Enter.
//   4. Read the gap list. If it looks right, type YES at the prompt.
//
// SAFE TO RE-RUN: same dedupe pattern as Phase 2 (legacy_id match OR
// (clientId|date|time) tuple match). Already-migrated rows are skipped.
//
// HOW IT DIFFERS FROM PHASE 2:
//   • No date-range / status / by-month dry-run output — gap count is
//     expected to be tiny (<50), so the report is just the ID list.
//   • Always prompts even for 0 gaps (so Tom sees the "all clear").
//   • Carries the same legacy_id-on-write guarantee so re-runs dedupe.
// =====================================================================

(async function sprint10Phase25Rescue() {
  console.log('%c[Sprint 10 Phase 2.5] Rescue missing-from-Supabase jobs', 'color:#06d;font-weight:bold;font-size:14px');

  // ===== Sanity =====
  if (!window.PentaJobs) { console.error('  ✗ PentaJobs missing. Are you on the v10 build?'); return; }
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { console.error('  ✗ supabase client not ready'); return; }
  console.log('  ✓ facade + supabase client present');

  // ===== Hydrate (paginated since v10.0.1) =====
  console.log('  hydrating PentaJobs from Supabase...');
  await window.PentaJobs.ready();
  var existingJobs = window.PentaJobs.listSync();
  console.log('    Supabase jobs: ' + existingJobs.length);

  // ===== Read localStorage =====
  var lsJobs = [];
  try { lsJobs = JSON.parse(localStorage.getItem('cleanco_jobs') || '[]'); } catch (e) {}
  console.log('    localStorage cleanco_jobs: ' + lsJobs.length);

  // ===== Build dedupe indexes =====
  var jobsByLegacy = Object.create(null);
  var jobsByTuple  = Object.create(null);
  for (var i = 0; i < existingJobs.length; i++) {
    var ej = existingJobs[i];
    if (ej.legacy_id) jobsByLegacy[ej.legacy_id] = true;
    jobsByTuple[(ej.clientId || '') + '|' + ej.date + '|' + (ej.time || '')] = true;
  }

  // ===== Find gaps =====
  var gaps = [];
  var skippedBad = 0;
  for (var i = 0; i < lsJobs.length; i++) {
    var lj = lsJobs[i];
    if (!lj || !lj.date) { skippedBad++; continue; }
    var idStr = lj.id != null ? String(lj.id) : null;
    if (idStr && jobsByLegacy[idStr]) continue;
    var tk = (lj.clientId || '') + '|' + lj.date + '|' + (lj.time || '');
    if (jobsByTuple[tk]) continue;
    gaps.push(Object.assign({}, lj, idStr ? { legacy_id: idStr } : {}));
  }

  console.log('');
  console.log('  malformed/skipped local entries: ' + skippedBad);
  console.log('  gaps (in localStorage but not Supabase): ' + gaps.length);
  if (gaps.length === 0) {
    console.log('%c  ✓ All clear — nothing to rescue.', 'color:#0a0;font-weight:bold');
    return;
  }
  if (gaps.length <= 30) {
    console.log('  missing IDs:');
    for (var i = 0; i < gaps.length; i++) {
      console.log('    ' + (gaps[i].id || '(no id)') + '   ' + gaps[i].date + (gaps[i].time ? ' ' + gaps[i].time : '') + '   ' + (gaps[i].clientName || gaps[i].clientId || ''));
    }
  } else {
    console.log('  missing (first 10 of ' + gaps.length + '):');
    for (var i = 0; i < 10; i++) {
      console.log('    ' + (gaps[i].id || '(no id)') + '   ' + gaps[i].date);
    }
    console.log('    … and ' + (gaps.length - 10) + ' more');
  }

  // ===== Type-YES =====
  var resp = prompt('Insert ' + gaps.length + ' missing job(s) into Supabase?\n\nType YES to proceed.');
  if (resp !== 'YES') {
    console.warn('  Aborted (response: ' + JSON.stringify(resp) + ').');
    return;
  }
  console.log('  ✓ confirmed — inserting');

  // ===== Insert =====
  // Single batch — gap count is expected tiny; no need to chunk. If
  // someone re-runs after a giant divergence, PostgREST 1MB body limit
  // would still allow ~1500+ jobs in one call. Add a chunked path only
  // if a real install hits that.
  var t0 = Date.now();
  try {
    var inserted = await window.PentaJobs.insertBatch(gaps);
    var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('');
    console.log('%c[Sprint 10 Phase 2.5] Rescued ' + inserted.length + '/' + gaps.length + ' in ' + elapsed + 's.', 'color:#0a0;font-weight:bold;font-size:14px');
    console.log('  Final Supabase jobs count: ' + window.PentaJobs.listSync().length);
  } catch (e) {
    console.error('  ✗ insertBatch failed:', e);
    console.warn('  No localStorage changes were made. Diagnose and re-run — legacy_id dedupe will skip anything that did insert.');
  }
})().catch(function(e) {
  console.error('[Sprint 10 Phase 2.5] Fatal:', e);
});
