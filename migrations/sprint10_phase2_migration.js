// =====================================================================
// Sprint 10 Phase 2 — one-shot localStorage → Supabase data migration.
//
// HOW TO RUN:
//   1. Open the manager app in the browser whose localStorage holds the
//      canonical data (Tom's manager phone OR Mac — whichever has the
//      most recent edits). Sign in.
//   2. Wait until the home screen has loaded (so PentaJobs +
//      PentaAssignments hydrate from Supabase first — that drives the
//      dedupe).
//   3. Open DevTools console.
//   4. Paste this entire file. Press Enter.
//   5. Read the DRY-RUN report. If it looks right, type YES at the
//      prompt. If not, type anything else to abort.
//
// SAFETY:
//   • Type-YES confirmation BEFORE any writes. Cancel = no writes.
//   • Idempotent: every insert carries the original ID as legacy_id, so
//     re-running dedupes already-migrated rows. If a batch fails
//     mid-way, just re-run — the script picks up where it left off.
//   • Auto-rollback on failure: tries sb.delete().in('id', insertedIds).
//     If the rollback also fails, prints the full ID list so Tom can
//     copy-paste a manual cleanup or just re-run (legacy_id dedupe will
//     leave the partials alone and finish the rest).
//   • localStorage is INTENTIONALLY NOT CLEARED. Phase 6 (v10.1) strips
//     it after the 24-48h dual-write safety window.
//
// BATCH PLAN: chunkSize = 300. 2204 jobs → ~8 chunks. Conservative re:
// PostgREST request size limits (default 1MB body); each row ~600 bytes
// at the upper end → ~180KB per chunk, well within budget.
// =====================================================================

(async function sprint10Phase2DataMigration() {
  var CHUNK_SIZE = 300;
  console.log('%c[Sprint 10 Phase 2] localStorage → Supabase migration', 'color:#06d;font-weight:bold;font-size:14px');

  // ===== Sanity =====
  if (!window.PentaJobs || !window.PentaAssignments || !window.PentaEmployees) {
    console.error('  ✗ facades missing. Are you on the v10 build?');
    return;
  }
  var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { console.error('  ✗ supabase client not ready'); return; }
  console.log('  ✓ facades + supabase client present');

  // ===== Hydrate =====
  console.log('  hydrating from Supabase...');
  await window.PentaJobs.ready();
  await window.PentaAssignments.ready();
  if (window.PentaEmployees.ready) await window.PentaEmployees.ready();
  var existingJobs    = window.PentaJobs.listSync();
  var existingAssigns = window.PentaAssignments.listSync();
  var employees       = window.PentaEmployees.listSync();
  console.log('    Supabase jobs:                ' + existingJobs.length);
  console.log('    Supabase active assignments:  ' + existingAssigns.length);
  console.log('    Supabase employees:           ' + employees.length);

  // ===== Read localStorage =====
  var lsJobs = [];
  try { lsJobs = JSON.parse(localStorage.getItem('cleanco_jobs') || '[]'); } catch (e) {}
  var lsAssigns = {};
  try { lsAssigns = JSON.parse(localStorage.getItem('daily_assignments') || '{}'); } catch (e) {}
  console.log('    localStorage cleanco_jobs:    ' + lsJobs.length);
  console.log('    localStorage daily_assignments keys: ' + Object.keys(lsAssigns).length);

  // ===== Dedupe jobs =====
  // Index by legacy_id (definitive on re-run) AND (clientId|date|time)
  // tuple (cross-device cold migration with no shared IDs).
  var jobsByLegacy = Object.create(null);
  var jobsByTuple  = Object.create(null);
  for (var i = 0; i < existingJobs.length; i++) {
    var ej = existingJobs[i];
    if (ej.legacy_id) jobsByLegacy[ej.legacy_id] = ej;
    jobsByTuple[(ej.clientId || '') + '|' + ej.date + '|' + (ej.time || '')] = ej;
  }
  var jobsToInsert = [];
  var jobsSkippedDup = 0;
  var jobsSkippedBad = 0;
  for (var i = 0; i < lsJobs.length; i++) {
    var lj = lsJobs[i];
    if (!lj || !lj.date) { jobsSkippedBad++; continue; }
    var idStr = lj.id != null ? String(lj.id) : null;
    if (idStr && jobsByLegacy[idStr]) { jobsSkippedDup++; continue; }
    var tk = (lj.clientId || '') + '|' + lj.date + '|' + (lj.time || '');
    if (jobsByTuple[tk]) { jobsSkippedDup++; continue; }
    // Carry the original ID into legacy_id so re-runs dedupe correctly
    // even when (clientId, date, time) collides with another row.
    jobsToInsert.push(Object.assign({}, lj, idStr ? { legacy_id: idStr } : {}));
  }

  // ===== Dedupe assignments =====
  var assignsByKey = Object.create(null);
  for (var i = 0; i < existingAssigns.length; i++) {
    var ea = existingAssigns[i];
    assignsByKey[ea.date + '_' + ea.employee_id] = ea;
  }
  var validEmpIds = Object.create(null);
  for (var i = 0; i < employees.length; i++) {
    if (employees[i].id) validEmpIds[employees[i].id] = true;
  }
  var assignsToInsert = [];
  var assignsSkippedDup = 0;
  var assignsSkippedOrphan = 0;
  var assignsSkippedBad = 0;
  Object.keys(lsAssigns).forEach(function(k) {
    var team = lsAssigns[k];
    if (!team || typeof team !== 'string') { assignsSkippedBad++; return; }
    if (k.length < 12 || k.charAt(10) !== '_') { assignsSkippedBad++; return; }
    var date = k.slice(0, 10);
    var empId = k.slice(11);
    if (!validEmpIds[empId]) { assignsSkippedOrphan++; return; }
    if (assignsByKey[date + '_' + empId]) { assignsSkippedDup++; return; }
    assignsToInsert.push({ date: date, team: team, employee_id: empId });
  });

  // ===== Compose dry-run analytics =====
  var minDate = null, maxDate = null;
  var statusScheduled = 0, statusCompleted = 0, statusCancelled = 0;
  var autoCount = 0;
  var byMonth = Object.create(null);
  for (var i = 0; i < jobsToInsert.length; i++) {
    var j = jobsToInsert[i];
    if (!minDate || j.date < minDate) minDate = j.date;
    if (!maxDate || j.date > maxDate) maxDate = j.date;
    if (j.cancelled) statusCancelled++;
    else if (j.done) statusCompleted++;
    else statusScheduled++;
    if (j.autoGenerated) autoCount++;
    var m = (j.date || '').slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  var monthKeys = Object.keys(byMonth).sort();

  var nChunks = Math.ceil(jobsToInsert.length / CHUNK_SIZE);

  // ===== Dry-run report =====
  console.log('');
  console.log('%c================ DRY RUN ================', 'color:#888;font-weight:bold');
  console.log('  jobs in localStorage:           ' + lsJobs.length);
  console.log('    already in Supabase:          ' + jobsSkippedDup);
  console.log('    malformed/skipped:            ' + jobsSkippedBad);
  console.log('    %c→ to insert:                  ' + jobsToInsert.length, 'font-weight:bold;color:#06d');
  if (jobsToInsert.length) {
    console.log('  date range:                     ' + minDate + '  →  ' + maxDate);
    console.log('  by status:');
    console.log('    scheduled:                    ' + statusScheduled);
    console.log('    completed:                    ' + statusCompleted);
    console.log('    cancelled:                    ' + statusCancelled);
    console.log('  by origin:');
    console.log('    auto-generated (recurring):   ' + autoCount);
    console.log('    manual:                       ' + (jobsToInsert.length - autoCount));
    if (monthKeys.length <= 18) {
      console.log('  by month:');
      monthKeys.forEach(function(k) { console.log('    ' + k + ':                       ' + byMonth[k]); });
    } else {
      console.log('  by month: ' + monthKeys.length + ' distinct months (' + monthKeys[0] + ' … ' + monthKeys[monthKeys.length - 1] + ')');
    }
    console.log('  batch plan:                     ' + nChunks + ' chunk(s) of up to ' + CHUNK_SIZE);
  }
  console.log('  ----------------------------------------');
  console.log('  assignments in localStorage:    ' + Object.keys(lsAssigns).length);
  console.log('    already in Supabase:          ' + assignsSkippedDup);
  console.log('    orphan (employee gone):       ' + assignsSkippedOrphan);
  console.log('    malformed/skipped:            ' + assignsSkippedBad);
  console.log('    %c→ to insert:                  ' + assignsToInsert.length, 'font-weight:bold;color:#06d');
  console.log('%c=========================================', 'color:#888;font-weight:bold');
  console.log('');

  if (jobsToInsert.length === 0 && assignsToInsert.length === 0) {
    console.log('%c[Sprint 10 Phase 2] Nothing to migrate. Already in sync.', 'color:#0a0;font-weight:bold');
    return;
  }

  // ===== Type-YES confirmation =====
  var msg = 'About to migrate ' + jobsToInsert.length + ' jobs and ' +
            assignsToInsert.length + ' assignments to Supabase.\n\n' +
            'Batch plan: ' + nChunks + ' chunk(s) of up to ' + CHUNK_SIZE + ' jobs.\n' +
            'localStorage will NOT be cleared (24-48h dual-write safety).\n\n' +
            'Type YES to proceed.';
  var resp = prompt(msg);
  if (resp !== 'YES') {
    console.warn('  Aborted (response: ' + JSON.stringify(resp) + ').');
    return;
  }
  console.log('  ✓ confirmed — beginning insert');
  var t0 = Date.now();

  // ===== Insert jobs (chunked, with ID tracking + rollback) =====
  var insertedIds = [];
  var halted = false;
  if (jobsToInsert.length) {
    console.log('  inserting ' + jobsToInsert.length + ' jobs in ' + nChunks + ' chunks...');
    for (var ofs = 0; ofs < jobsToInsert.length; ofs += CHUNK_SIZE) {
      var chunkNum = Math.floor(ofs / CHUNK_SIZE) + 1;
      var chunk = jobsToInsert.slice(ofs, ofs + CHUNK_SIZE);
      var chunkStart = Date.now();
      try {
        var ins = await window.PentaJobs.insertBatch(chunk);
        for (var k = 0; k < ins.length; k++) {
          if (ins[k] && ins[k].id) insertedIds.push(ins[k].id);
        }
        var elapsed = Date.now() - chunkStart;
        console.log('    chunk ' + chunkNum + '/' + nChunks + ': inserted ' + ins.length + '/' + chunk.length +
                    '  (' + elapsed + 'ms,  running total: ' + insertedIds.length + '/' + jobsToInsert.length + ')');
      } catch (e) {
        console.error('    ✗ chunk ' + chunkNum + '/' + nChunks + ' failed:', e);
        halted = true;
        break;
      }
    }
  }

  // ===== Rollback on failure =====
  if (halted) {
    console.warn('');
    console.warn('%c[Sprint 10 Phase 2] HALTED. Attempting rollback of ' + insertedIds.length + ' inserted rows...', 'color:#a00;font-weight:bold');
    if (insertedIds.length === 0) {
      console.warn('  Nothing to rollback. localStorage is untouched. Diagnose the failure and re-run.');
      return;
    }
    var rollbackOk = false;
    try {
      // Chunk the delete too — IN clauses with thousands of UUIDs can
      // exceed URL length. 200 per delete is safe.
      var rolledBack = 0;
      for (var ofs = 0; ofs < insertedIds.length; ofs += 200) {
        var idsChunk = insertedIds.slice(ofs, ofs + 200);
        var del = await sb.from('jobs').delete().in('id', idsChunk);
        if (del.error) throw del.error;
        rolledBack += idsChunk.length;
      }
      rollbackOk = (rolledBack === insertedIds.length);
      console.warn('  ✓ rolled back ' + rolledBack + ' rows. localStorage is untouched. Diagnose and re-run.');
    } catch (rbErr) {
      console.error('  ✗ rollback FAILED:', rbErr);
    }
    if (!rollbackOk) {
      console.warn('  --- INSERTED IDs (rollback failed; copy this list) ---');
      console.warn(JSON.stringify(insertedIds));
      console.warn('  --- end IDs ---');
      console.warn('  Recovery options:');
      console.warn('    A) RE-RUN this script. The legacy_id dedupe will skip these rows; the rest will insert.');
      console.warn('    B) Manually delete via:  await supabaseClient.from(\'jobs\').delete().in(\'id\', <pasted_ids>)');
    }
    return;
  }

  // ===== Insert assignments (single batch via raw supabase) =====
  // For Tom\'s 0-row assignment dataset this is a no-op. For populated
  // installs, single-shot batch insert is faster than the per-row
  // PentaAssignments.assign() and the partial unique index enforces
  // safety server-side.
  if (assignsToInsert.length) {
    console.log('  inserting ' + assignsToInsert.length + ' assignments...');
    var bid = null;
    try {
      var sess = (window.PentaAuth && window.PentaAuth.session);
      bid = sess && sess.user && sess.user.user_metadata && sess.user.user_metadata.business_id;
    } catch (e) {}
    if (!bid && employees.length) bid = employees[0].business_id;
    if (!bid) {
      console.error('  ✗ could not derive business_id; assignments NOT inserted');
    } else {
      var aRows = assignsToInsert.map(function(a) {
        return { business_id: bid, date: a.date, team: a.team, employee_id: a.employee_id };
      });
      var aIns = await sb.from('daily_assignments').insert(aRows).select();
      if (aIns.error) {
        console.error('  ✗ assignments batch insert failed:', aIns.error);
      } else {
        console.log('  assignments inserted: ' + (aIns.data || []).length + ' / ' + aRows.length);
        try { await window.PentaAssignments._hydrate(); } catch (e) {}
      }
    }
  }

  // ===== Summary =====
  var totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log('%c[Sprint 10 Phase 2] Migration complete in ' + totalSec + 's.', 'color:#0a0;font-weight:bold;font-size:14px');
  console.log('  Final Supabase counts:');
  console.log('    jobs:        ' + window.PentaJobs.listSync().length);
  console.log('    assignments: ' + window.PentaAssignments.listSync().length);
  console.log('  localStorage retained for 24-48h safety. Phase 6 strips it.');
  console.log('  Verify on a SECOND device: open the app, run');
  console.log('    await PentaJobs.ready(); PentaJobs.listSync().length');
  console.log('  Should match the count above.');
})().catch(function(e) {
  console.error('[Sprint 10 Phase 2] Fatal:', e);
});
