#!/usr/bin/env python3
"""Hire-transfer-missing-fields fix -- PART 2, the core fix.

hireApplicant() used to copy ONLY first/last name, phone, and email
from the application into the new employee row -- everything else the
applicant typed (address, work authorization, driver's license,
availability, experience, emergency contact, preferred language) was
silently dropped, even though the employee side already has a
matching column for almost all of it (confirmed by reading
PentaEmployees._toRow/_fromRow -- the Staff edit form already reads
and writes every one of these columns for manager-entered data; the
hire step just never populated them in the first place).

ONE explicit application-field -> employee-field mapping table below,
so nothing can silently drop again. Notes on the non-obvious ones:

- address/city/state/zip_code->zip: both sides already use plain,
  separate address/city/state/zip text fields (job_applications.state/
  zip_code are real columns even though the application FORM itself
  has no input for either today -- a separate, pre-existing gap,
  reported but not fixed here) -- no one-line-vs-split conflict exists
  in this schema to reconcile.
- work_authorization->work_auth, drivers_license_status->has_license,
  emergency_contact_relation->emergency_contact_relationship: plain
  name mismatches.
- available_days: the application stores it as a comma-joined STRING
  ("Mon,Tue,Wed"); the employee column is a real Postgres ARRAY --
  split before handing it to _toRow, which expects an array here.
- hours_per_week_desired -> preferred_start_time: NOT a typo. The
  application form's own #app-hours field is labeled "Preferred start
  time" with time-of-day options (early/morning/etc) -- a separate,
  pre-existing bug in submitApplication saves that answer under the
  misleadingly-named hours_per_week_desired column instead (reported
  separately, not fixed here; there is no genuine "hours per week"
  question anywhere in the form). Mapped here by what the data
  actually IS, not by the column's misleading name, so it lands on
  the correctly-named employee field instead of being dropped either
  way.
- preferred_language: written directly now (not just the lossy
  culture_tag short-code derived from it, which still also happens,
  unchanged, for the existing language-selector UI).
- Deliberately NOT copied: hear_about_us/referred_by (recruiting-
  funnel metadata about the APPLICATION, not the employee), signature_
  full_name/signature_date_iso (a legal artifact of the application
  itself), and driver_license_front_url/driver_license_back_url/
  ssn_card_url/passport_url (identity-document photos -- the employee
  side has no document storage at all today; creating one is a bigger,
  separate decision about access/visibility, reported not fixed here).
- has_reliable_transportation/prior_employer/earliest_start_date need
  migration 124 (3 brand-new columns) -- applied in a SEPARATE,
  best-effort follow-up patch AFTER the main insert, so a hire can
  never fail just because that migration hasn't landed yet on a given
  environment; a failure there is logged, not surfaced to the manager.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from _apply_edits import apply_edits

OLD = """async function hireApplicant(id) {
  if (!confirm('Hire this applicant? This creates an employee record. You will then need to manually tap Send Invite from the Staff tab when ready.')) return;
  const sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { alert('Sign in required'); return; }
  const { data: app, error: fetchErr } = await sb.from('job_applications').select('*').eq('id', id).single();
  if (fetchErr || !app) { alert('Failed to load applicant'); return; }
  const langMap = { es:'mx', pt:'br', ko:'kr', kr:'kr', en:'us', cv:'cv' };
  const phoneClean = String(app.phone || '').replace(/\\D/g, '') || null;
  const empRow = {
    business_id: app.business_id,
    first_name: app.first_name,
    last_name: app.last_name || '-',
    phone: phoneClean,
    email: app.email || null,
    email_is_internal: !app.email,
    culture_tag: langMap[app.preferred_language] || 'us',
    status: 'active',
    legacy_roster_id: 'app_' + String(app.id).slice(0, 8)
  };

  // Sprint 4.2.B fix — pre-check for email conflict to give a clearer error
  if (app.email) {
    const { data: existing } = await sb
      .from('employees')
      .select('id, first_name, last_name')
      .eq('business_id', app.business_id)
      .eq('email', app.email)
      .maybeSingle();
    if (existing) {
      alert('An employee with email ' + app.email + ' already exists (' + existing.first_name + ' ' + existing.last_name + '). Cannot hire as duplicate. Update the application email or merge with existing employee.');
      return;
    }
  }

  let empData;
  try {
    empData = await window.PentaEmployees.insert(empRow);
  } catch (e) {
    alert('Hire failed: ' + (e.message || String(e)));
    return;
  }
  const session = await sb.auth.getSession();"""

NEW = """async function hireApplicant(id) {
  if (!confirm('Hire this applicant? This creates an employee record. You will then need to manually tap Send Invite from the Staff tab when ready.')) return;
  const sb = window.supabaseClient || (window.PentaAuth && window.PentaAuth.client);
  if (!sb) { alert('Sign in required'); return; }
  const { data: app, error: fetchErr } = await sb.from('job_applications').select('*').eq('id', id).single();
  if (fetchErr || !app) { alert('Failed to load applicant'); return; }
  const langMap = { es:'mx', pt:'br', ko:'kr', kr:'kr', en:'us', cv:'cv' };
  const phoneClean = String(app.phone || '').replace(/\\D/g, '') || null;

  // Hire-transfer-missing-fields fix: ONE explicit application-field ->
  // employee-field mapping, so a hire can never silently drop a field
  // the applicant actually filled in. See this script's own header
  // comment for the reasoning behind every non-obvious line below.
  const empRow = {
    business_id: app.business_id,
    first_name: app.first_name,
    last_name: app.last_name || '-',
    phone: phoneClean,
    email: app.email || null,
    email_is_internal: !app.email,
    culture_tag: langMap[app.preferred_language] || 'us',
    preferred_language: app.preferred_language || null,
    status: 'active',
    legacy_roster_id: 'app_' + String(app.id).slice(0, 8),
    address: app.address || null,
    city: app.city || null,
    state: app.state || null,
    zip: app.zip_code || null,
    workAuth: app.work_authorization || null,
    hasLicense: app.drivers_license_status || null,
    availDays: app.available_days ? String(app.available_days).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : null,
    experience: app.prior_cleaning_experience || null,
    // See header comment: this is the applicant's "preferred start
    // time" answer, not a real "hours per week" value -- mapped by
    // what the data actually is.
    prefTime: app.hours_per_week_desired || null,
    emergency_contact_name: app.emergency_contact_name || null,
    emergency_contact_phone: app.emergency_contact_phone || null,
    emRel: app.emergency_contact_relation || null
  };

  // Sprint 4.2.B fix — pre-check for email conflict to give a clearer error
  if (app.email) {
    const { data: existing } = await sb
      .from('employees')
      .select('id, first_name, last_name')
      .eq('business_id', app.business_id)
      .eq('email', app.email)
      .maybeSingle();
    if (existing) {
      alert('An employee with email ' + app.email + ' already exists (' + existing.first_name + ' ' + existing.last_name + '). Cannot hire as duplicate. Update the application email or merge with existing employee.');
      return;
    }
  }

  let empData;
  try {
    empData = await window.PentaEmployees.insert(empRow);
  } catch (e) {
    alert('Hire failed: ' + (e.message || String(e)));
    return;
  }

  // Hire-transfer-missing-fields fix: has_reliable_transportation/
  // prior_employer/earliest_start_date need migration 124 -- applied
  // as a SEPARATE, best-effort patch after the main insert so a hire
  // can never fail just because that migration hasn't landed yet on a
  // given environment. A failure here is logged, never shown to the
  // manager -- the hire itself already fully succeeded above.
  try {
    await window.PentaEmployees.update(empData.id, {
      has_reliable_transportation: (app.has_reliable_transportation === true || app.has_reliable_transportation === false) ? app.has_reliable_transportation : null,
      prior_employer: app.prior_employer || null,
      earliest_start_date: app.earliest_start_date || null
    });
  } catch (e) {
    console.warn('[hireApplicant] optional fields patch failed (needs migration 124 applied):', e);
  }

  const session = await sb.auth.getSession();"""

EDITS = [
    ("Hire-transfer-missing-fields fix: hireApplicant copies every mapped field", OLD, NEW),
]

if __name__ == "__main__":
    apply_edits(EDITS)
