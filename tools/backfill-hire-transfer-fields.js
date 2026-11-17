// Hire-transfer-missing-fields fix — backfill for employees hired through
// an application BEFORE hireApplicant() was fixed to copy every field.
//
// Same "paste in console" pattern as backfill-retry-geocode.js. Runs under
// the signed-in manager's own session, so it writes with the manager's own
// already-granted permissions — no service-role key needed here.
//
// Field mapping (must stay identical to hireApplicant()'s own mapping table
// in index.html — if that mapping ever changes, update this list too):
//   application column              -> employee column               type
//   address                         -> address                       string
//   city                            -> city                           string
//   state                           -> state                          string
//   zip_code                        -> zip                            string
//   work_authorization              -> work_auth                      string
//   drivers_license_status          -> has_license                    string
//   available_days (comma string)   -> available_days (array)         array
//   prior_cleaning_experience       -> experience                     string
//   hours_per_week_desired          -> preferred_start_time (*)       string
//   emergency_contact_name          -> emergency_contact_name         string
//   emergency_contact_phone         -> emergency_contact_phone        string
//   emergency_contact_relation      -> emergency_contact_relationship string
//   preferred_language              -> preferred_language             string
//   has_reliable_transportation (**)-> has_reliable_transportation    boolean
//   prior_employer (**)             -> prior_employer                 string
//   earliest_start_date (**)        -> earliest_start_date            date
//
// (*)  Semantic remap, not a name match — see hireApplicant()'s own comment.
// (**) Needs migration 124 applied. If that migration hasn't landed yet on
//      this environment, Supabase will reject the UPDATE for these 3 fields
//      with an "unknown column" error — caught per-row and logged, never
//      blocks the other fields on the same employee.
//
// Safety rules (do not change without re-reading the task this shipped for):
//   - Only ever fills a field that is CURRENTLY EMPTY on the employee row.
//     Never overwrites anything already there (manager-typed or otherwise).
//   - UPDATE only, never INSERT — re-running is always safe, never creates
//     duplicate rows, and running it again after it already filled a field
//     is a no-op for that field.
//   - Never prints a value. Only field names and counts, per the privacy
//     rule this task shipped under.
//
// Usage (paste this whole file in the browser console, signed in as a
// manager, then call one of):
//   window._backfillHireFields({})                                 // dry run, ALL hires
//   window._backfillHireFields({ employeeId: '<uuid>' })            // dry run, ONE hire
//   window._backfillHireFields({ employeeId: '<uuid>', apply: true })// APPLY for one hire
//   window._backfillHireFields({ apply: true })                    // APPLY for ALL hires
//                                                                   // (only after reviewing
//                                                                   //  the dry run above)

(function () {
  var FIELD_MAP = [
    { app: 'address', emp: 'address', type: 'string' },
    { app: 'city', emp: 'city', type: 'string' },
    { app: 'state', emp: 'state', type: 'string' },
    { app: 'zip_code', emp: 'zip', type: 'string' },
    { app: 'work_authorization', emp: 'work_auth', type: 'string' },
    { app: 'drivers_license_status', emp: 'has_license', type: 'string' },
    { app: 'available_days', emp: 'available_days', type: 'csv_array' },
    { app: 'prior_cleaning_experience', emp: 'experience', type: 'string' },
    { app: 'hours_per_week_desired', emp: 'preferred_start_time', type: 'string' },
    { app: 'emergency_contact_name', emp: 'emergency_contact_name', type: 'string' },
    { app: 'emergency_contact_phone', emp: 'emergency_contact_phone', type: 'string' },
    { app: 'emergency_contact_relation', emp: 'emergency_contact_relationship', type: 'string' },
    { app: 'preferred_language', emp: 'preferred_language', type: 'string' },
    { app: 'has_reliable_transportation', emp: 'has_reliable_transportation', type: 'boolean' },
    { app: 'prior_employer', emp: 'prior_employer', type: 'string' },
    { app: 'earliest_start_date', emp: 'earliest_start_date', type: 'string' }
  ];

  function appHasValue(app, field) {
    var v = app[field.app];
    if (field.type === 'boolean') return v === true || v === false;
    if (field.type === 'csv_array') return !!(v && String(v).trim());
    return v != null && String(v).trim() !== '';
  }

  function empIsEmpty(emp, field) {
    var v = emp[field.emp];
    if (field.type === 'boolean') return v == null;
    if (field.type === 'csv_array') return !Array.isArray(v) || v.length === 0;
    return v == null || String(v).trim() === '';
  }

  function buildPatchValue(app, field) {
    var v = app[field.app];
    if (field.type === 'csv_array') {
      return String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return v;
  }

  window._backfillHireFields = async function (opts) {
    opts = opts || {};
    var sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
    if (!sb) { console.error('[backfill] sign-in required'); return; }

    var appQuery = sb.from('job_applications').select('*').eq('status', 'hired').not('hired_employee_id', 'is', null);
    var { data: apps, error: appErr } = await appQuery;
    if (appErr) { console.error('[backfill] failed to load applications', appErr); return; }

    var targets = opts.employeeId ? apps.filter(function (a) { return a.hired_employee_id === opts.employeeId; }) : apps;
    console.log('[backfill] ' + targets.length + ' hired-via-application record(s) to check' + (opts.apply ? ' — APPLY MODE' : ' — DRY RUN (no writes)'));

    var totalMissing = 0, totalFilled = 0, totalSkippedNoColumn = 0;

    for (var i = 0; i < targets.length; i++) {
      var app = targets[i];
      var { data: emp, error: empErr } = await sb.from('employees').select('*').eq('id', app.hired_employee_id).maybeSingle();
      if (empErr || !emp) {
        console.warn('[backfill] could not load employee for application ' + app.id + ' (employee may have been deleted)');
        continue;
      }

      var missingFields = [];
      var patch = {};
      FIELD_MAP.forEach(function (field) {
        if (appHasValue(app, field) && empIsEmpty(emp, field)) {
          missingFields.push(field.emp);
          patch[field.emp] = buildPatchValue(app, field);
        }
      });

      var label = emp.first_name + ' ' + (emp.last_name || '').charAt(0) + '.'; // first name + last initial only
      if (missingFields.length === 0) {
        console.log('[backfill] ' + label + ': nothing missing');
        continue;
      }

      totalMissing += missingFields.length;
      console.log('[backfill] ' + label + ': ' + missingFields.length + ' field(s) would be filled -> ' + missingFields.join(', '));

      if (opts.apply) {
        try {
          await window.PentaEmployees.update(emp.id, patch);
          totalFilled += missingFields.length;
          console.log('[backfill]   ✓ applied');
        } catch (e) {
          // Most likely cause: migration 124 not applied yet on this
          // environment, so has_reliable_transportation/prior_employer/
          // earliest_start_date don't exist as columns. Retry with just
          // the fields that don't need migration 124.
          var safeFields = ['has_reliable_transportation', 'prior_employer', 'earliest_start_date'];
          var retryPatch = {};
          var retryCount = 0;
          Object.keys(patch).forEach(function (k) {
            if (safeFields.indexOf(k) === -1) { retryPatch[k] = patch[k]; retryCount++; }
          });
          if (retryCount > 0) {
            try {
              await window.PentaEmployees.update(emp.id, retryPatch);
              totalFilled += retryCount;
              totalSkippedNoColumn += (missingFields.length - retryCount);
              console.log('[backfill]   ✓ applied ' + retryCount + ' field(s); skipped the rest (needs migration 124): ' + e.message);
            } catch (e2) {
              console.error('[backfill]   ✗ failed even on retry for ' + label, e2);
            }
          } else {
            totalSkippedNoColumn += missingFields.length;
            console.warn('[backfill]   skipped (needs migration 124): ' + e.message);
          }
        }
      }
    }

    console.log('[backfill] DONE. total missing field-slots: ' + totalMissing + (opts.apply ? (', filled: ' + totalFilled + ', skipped (needs migration 124): ' + totalSkippedNoColumn) : ' (dry run — nothing written)'));
  };

  console.log('[backfill] loaded. Call window._backfillHireFields({...}) — see file header for usage.');
})();
