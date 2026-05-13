# Penta — Technical Architecture

This document captures the runtime + data architecture of Penta as of v11.0.0 (May 11, 2026). It is the canonical reference for how multi-tenancy works, where security boundaries sit, and what is and isn't safe to assume when adding new features.

Update this document whenever the foundational architecture changes (auth flow, tenancy model, RLS pattern, Claire's scope, etc.). Do not update it for routine product features.

---

## 1. Stack overview

- **Frontend:** Single-page web app delivered as one large `index.html` (~38k lines, embedded `<script>`). Hosted on GitHub Pages today (`https://captainclean115-oss.github.io/cleaningapp/`). PWA in spirit, not yet packaged native.
- **Database:** Supabase Postgres (project ref `wymoezilyjmyibmuqqmr`). Single shared schema (`public`).
- **Auth:** Supabase Auth. JWTs in localStorage. `auth.uid()` is the integration point between the browser session and Postgres.
- **Server-side compute:** Supabase Edge Functions (Deno). Four functions live today: `accept-invite`, `set-employee-password`, `translate-chat`, `send-sms`.
- **External integrations:** RingCentral (SMS via `send-sms` Edge Function), Anthropic (Claire prompts — currently direct browser, see §6), Nominatim (geocoding, throttled + neg-cached client-side).

---

## 2. Multi-tenancy model

### Pattern

Shared schema, single Postgres database, **`business_id uuid` column on every tenant-scoped table**. 96 of ~105 `public` tables carry `business_id`. Row-Level Security (RLS) is enabled on every table.

The 9 tables without `business_id` (audited in v11.0.0 Item 4 and documented in `migrations/038`):

| Table | Scoping mechanism |
|---|---|
| `businesses` | RLS keyed on `id` (current user belongs to this business) |
| `organizations` | RLS joins `businesses.organization_id` |
| `affiliate_earnings` | RLS joins `purchase_orders.business_id` |
| `user_sessions` | RLS joins `users.business_id` |
| `webhook_deliveries` | RLS joins `webhooks.business_id` |
| `vendors`, `products`, `vendor_products` | Intentionally global catalogs (SELECT `true`, no PII) |
| `aggregation_snapshots` | Intentionally cross-tenant anonymized rollups, restricted to `authenticated` role (no anon) |

### The tenant gate: `auth_belongs_to_business(b_id uuid)`

This is the single SECURITY DEFINER function that every tenant-scoped policy calls. Returns true if the current `auth.uid()` has a `users` row matching `b_id`:

```sql
CREATE FUNCTION public.auth_belongs_to_business(b_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE auth_user_id = auth.uid()
      AND business_id = b_id
      AND deleted_at IS NULL
  );
$$;
```

A second function `auth_has_franchisor_access(b_id)` allows users with `role = 'franchisor_admin'` to read across sibling businesses under the same `organization_id`. Used in SELECT-only policies on `clients`, `payments`, `users`. Not in UPDATE/DELETE — franchisors look but don't modify.

### Roles

`public.users.role` enum:

| Role | Capabilities |
|---|---|
| `owner` | Full read/write on tenant |
| `admin` | Full read/write on tenant |
| `manager` | Full read/write on tenant; subset of admin settings |
| `dispatcher` | Same as manager for schedule + assignments; no settings |
| `employee` | Reads only own row + own time entries + own lunch breaks; writes own clock/lunch/job-actuals via SECURITY DEFINER RPCs |
| `franchisor_admin` | Read-only across all businesses in the same `organizations` parent |

Employees see only their own employees row via `employees_select` RLS (filtered by `auth_user_id = auth.uid()`). The team-roster RPC `get_business_teammates()` (SECURITY DEFINER, Migration 034) is the workaround: it bypasses RLS to return all active teammates of the caller's business for chip rendering on the schedule view.

### Auth → tenant binding flow

1. User signs in via Supabase Auth.
2. JWT contains `auth.uid()` (UUID from `auth.users`).
3. `public.users` row joins `auth_user_id = auth.uid()` to a `business_id`.
4. Every read or write through the authenticated Supabase client is automatically RLS-scoped to that business_id.

### `PentaTenant` — client-side tenant cache (v11.0.0)

`window.PentaTenant` is an IIFE declared at the very top of `index.html` (before any feature code), exposing `current() / ready() / _set()`. Boot router fetches `business_id` in the same query as `role` + `manager_permissions` and calls `PentaTenant._set` before any consumer wakes up.

`PentaClients` and `renderApplicantsList` read from `PentaTenant.current()`. PentaClients `_bizId()` throws fail-loud if called before resolution — a write with a missing business_id either lands in the wrong tenant or is silently RLS-rejected, both of which are worse than a thrown error.

The IIFE-at-top placement avoids the v10.5.37 hoisting trap (a top-level `var X = {}` below a call site hoists undefined; storing on `window` instead is order-independent).

---

## 3. Application form: the only public write surface

The job-application form is anonymous by design — applicants don't have accounts. As of v11.0.0:

1. Applicant visits `…/?biz=<slug>` (operator's unique link).
2. Boot router detects the URL param + no session, auto-calls `showApplication()`.
3. `showApplication()` calls `get_business_by_slug(slug)` RPC. Returns `(id, name)` or empty.
4. If empty → friendly error, form does not open.
5. Form binds to the resolved tenant. Hero brand renders the tenant's name dynamically (no more bolded "Manna Maids").
6. On submit, `submit_job_application(slug, payload)` RPC (SECURITY DEFINER) resolves slug → business_id server-side, validates required fields, inserts the row. Browser never sends `business_id` directly.

`REVOKE INSERT ON job_applications FROM anon` ensures the RPC is the only anon path. Managers using the in-person flow keep direct INSERT (gated by Migration 036's WITH CHECK).

Manager-side: the top of the Applicants tab renders "Your application link: `…?biz=<slug>`" with a Copy button.

Storage: doc uploads go to `applications/{business_id}/{appUuid}/{col}.{ext}` — path uses the resolved tenant id.

---

## 3a. Audit log (v11.0.6)

`audit_log` is the immutable event stream that powers both the Client Activity Log view and the Maids Sync Report.

**Capture strategy: hybrid.** Database triggers attached to 8 tenant-scoped tables provide the can't-miss floor. App-level `_auditSupplement(...)` calls layered on top of triggers add richer context for events the triggers can't see (e.g. cancellation `source`/`reason`, manager `manual_note`s, application slug + applicant identity). Two rows per logical event is acceptable — Sync Report queries by `action_type` and consumers pick the row they want.

**Cutover date:** triggers attached when migration 043 ran (2026-05-11). Events older than that are not captured (no backfill — intentional).

**Action vocabulary** (CHECK-constrained): `created`, `updated`, `deleted`, `restored`, `moved`, `cancelled`, `started`, `ended`, `submitted`, `approved`, `rejected`, `manual_note`, `manual_override`, `received`, `refunded`.

**Entity vocabulary** (CHECK-constrained): `job`, `client`, `employee`, `payment`, `application`, `time_entry`, `lunch_break`, `daily_assignment`, `client_key`, `office`, `team`, `system`.

**RLS:** Role-gated SELECT (manager-tier sees all in tenant; dispatcher sees scheduling-related entities only; employee sees own actions). INSERT WITH CHECK requires `user_id` NULL or = caller's `users.id`. No UPDATE or DELETE policies — events are immutable by design.

**Snapshots:** `old_values` and `new_values` are full row jsonb (`to_jsonb(NEW/OLD)`). Storage cost vs. flexibility tradeoff — accepted because audit_log will be partitioned-by-month before scale becomes a concern.

**Noise filter:** trigger function skips writes when only `updated_at` differs between OLD and NEW. Keeps realtime tick + mirror-write churn out of the log.

**Maids Sync Report (Phase 1)** consumes `audit_log` via `get_daily_sync_data(business_id, date)` — a SECURITY DEFINER RPC that aggregates events into a single JSONB payload (5 sections: new clients, schedule changes, time entries, client deletions, applications). Per-day state lives in `sync_reports` (one row per `(business_id, report_date)`), updated via `mark_sync_report_synced(business_id, date, notes)` which also writes a corresponding `'approved'/'system'` audit_log row so the sync action itself is part of the immutable trail.

---

## 4. Edge Functions

| Function | Auth | Purpose |
|---|---|---|
| `accept-invite` | none (JWT verify off — uses signed invite token) | Bootstraps a new business + first user during signup |
| `set-employee-password` | none (JWT verify off) | Sets initial password from an emailed/SMS'd token |
| `translate-chat` | JWT required | Server-side Anthropic Haiku call for chat translation. Holds `ANTHROPIC_API_KEY` as a Supabase secret |
| `send-sms` (v2, v11.0.2) | JWT required | Server-side SMS send. Resolves caller tenant from JWT, looks up `business_phone_integrations` row, branches on `credentials.source` to either env-source (Manna Maids transitional state) or in-DB credentials. Marks `mark_phone_integration_used` / `mark_phone_integration_error` after each attempt. Returns 424 with hint when no integration is configured for the tenant |

Edge Functions verify the caller's JWT and resolve tenant via `users.business_id` server-side. They do not trust browser-supplied tenant ids.

### Per-tenant phone provider integrations (v11.0.2)

Schema (Migration 039):

`business_phone_integrations` — one row per (business_id, provider). Columns: `provider` (check constraint: `ringcentral | text_request | twilio`), `phone_number_e164`, `credentials jsonb` (provider-specific shape), `status` (`active | disconnected | error`), `last_used_at`, `last_error`, soft delete. UNIQUE index on (business_id, provider) WHERE not deleted.

RLS gates the table to owners + admins for SELECT / INSERT / UPDATE / DELETE. Managers and below cannot read raw credentials — they invoke `send-sms` which uses service_role internally.

RPCs (all SECURITY DEFINER):
- `get_active_phone_integration(business_id, provider) → (phone_number_e164, credentials, status)` — used by the EF and the manager Settings status line.
- `mark_phone_integration_used(business_id, provider)` — service-role write after successful send. Resets status to active.
- `mark_phone_integration_error(business_id, provider, error_text)` — service-role write on failure. Sets status='error', stores last_error truncated to 500 chars.

For RingCentral, the `credentials` JSONB carries `{client_id, client_secret, refresh_token}`. Transitional case: `{source: "env"}` tells the EF to read from `RC_CLIENT_ID` / `RC_CLIENT_SECRET` / `RC_REFRESH_TOKEN` env vars instead — that's how Manna Maids' existing setup migrated without a credential rotation. Future tenants paste their RC credentials via the Admin → Phone & SMS settings modal; the row switches to in-DB credentials and env vars are no longer consulted for that tenant.

**Encryption at rest:** credentials live in plaintext within the JSONB today. RLS gates reads to owner+admin, and the EF reads via service_role which is the only path that touches the actual values. A future hardening step is to move credential values into Supabase Vault (pgsodium) and reference them by handle from the JSONB. Tracked as a follow-up; not blocking v11.0.x.

**Multi-provider support:** the provider check constraint already accepts `text_request` and `twilio`. Adding either is a matter of (a) extending the EF with the new send-path and (b) extending the Admin settings modal with the new credential fields. The schema doesn't change.

---

## 5. Storage

Supabase Storage buckets are not yet uniformly tenant-scoped at the bucket level — instead, **object paths begin with `business_id/`** (e.g. `applications/{business_id}/{appUuid}/...`). Storage RLS policies should mirror this — verifying any new bucket policy is required before using a new bucket for tenant data. This is a known weak spot that wasn't part of the v11.0.0 push.

---

## 6. Claire's scope — known weak spot

**This is a deferred item from the v11.0.0 push.** Claire's tables (`claire_conversations`, `claire_messages`, `claire_settings`, `claire_insights`) are all `business_id`-scoped with full RLS. Storage of Claire's history is properly tenant-scoped.

However, the actual Anthropic API calls happen **directly from the browser** in 5+ places in `index.html`. Pattern:

```js
fetch('https://api.anthropic.com/v1/messages', {
  headers: {
    'x-api-key': key,
    'anthropic-dangerous-direct-browser-access': 'true'
  },
  ...
})
```

The key is pulled from localStorage on the manager's device. Consequences:

- Inputs to Claire are tenant-correct **only** because the browser fetched them through RLS-scoped queries first. There is no server-side guard.
- Every manager device has the Anthropic API key in localStorage. A leak = quota drain (budget risk), not a tenant data leak.
- Streaming, retries, error shaping all live client-side.

**Mitigation path (deferred):** new Edge Function that takes (JWT, mode, vars), verifies the JWT, resolves business_id server-side, calls Anthropic with the secret-held key, returns the shaped response, and logs to `ai_usage_log`. Replace the 5+ direct-browser calls with `sb.functions.invoke('claire', {...})`.

Marked acceptable to defer because: tenant isolation is intact (Claire only sees what the browser already pulled through RLS); the risk is budget-side (API key exfiltration), not data-side.

---

## 7. RLS audit results (v11.0.0)

Documented across migrations 036 / 037 / 038.

| Audit | Result |
|---|---|
| INSERT WITH CHECK across 96 tenant-scoped tables | 95/96 already `auth_belongs_to_business`-gated; 9 additionally role-gated. Fixed: `job_applications_public_insert` (was `true` for anon → now requires real business_id, will be replaced by RPC). |
| SELECT/UPDATE/DELETE across the same 96 | Consistent `auth_belongs_to_business` pattern; spot-checked clients / jobs / payments / users. |
| 9 non-business_id tables | 6 FK-joined to business_id-bearing parents; 3 intentionally global catalog; 1 (`aggregation_snapshots`) tightened from PUBLIC to `authenticated`. |
| Anon write surface | Single SECURITY DEFINER RPC (`submit_job_application`). Direct INSERT revoked from anon on `job_applications`. |

---

## 8. Tenant onboarding — what works today, what doesn't

**Works today (v11.0.2):**
- New business row + first user can be created via the `accept-invite` Edge Function (server-side, service role).
- Operator sets a `slug` on their `businesses` row (defaults populated for the 4 existing tenants).
- Operator shares `…/?biz=<slug>` as their public application link.
- Applicants land on a form scoped to that tenant. Submissions write to the right `business_id`. Manager Applicants tab shows them.
- All tenant data reads + writes RLS-scoped via `auth_belongs_to_business`.
- Every operator-facing or applicant-facing string (handbook, social captions, Claire prompt context, SMS templates, weekly hours header, mailto subject, On-My-Way SMS, employee team chips) renders from the tenant's actual `businesses.name` / `users.first_name` / `businesses.metro_area` / live counts via PentaTenant readers. Zero hardcoded "Manna Maids" or "Tom" in runtime code.
- Each tenant brings its own RingCentral credentials via Admin → Phone & SMS settings. The active integration's `phone_number_e164` is the default outbound number. Multiple outbound numbers supported via `business_phone_numbers`.
- Manna Maids continues to work via env-source fallback during transition; switching to in-DB credentials is a 30-second modal action when ready.

**Outstanding:**
- Claire Edge Function migration (§6).
- Storage bucket-level RLS audit (§5).
- Credentials encryption-at-rest (pgsodium / Supabase Vault) for `business_phone_integrations.credentials`.

---

## 8c. Activity Log renderer (v11.0.14 — Build 1)

The Activity Log surfaces in two places: the global Updates tab (`renderActivityLog`) and the per-client overlay (`openClientActivityLog`). Both read from `public.audit_log` and now share one rendering pipeline.

**Contract: `_renderAuditRowSummary(row, ctx) → { summary, chips, drill }`**

- `row` is a raw audit_log row including `old_values` + `new_values` (full row snapshots from the capture trigger)
- `ctx = { users, clients, jobs, employees }` is built once per render by `_buildAuditContext(rows, sb)`. Users hit the DB once (batched `.in('id', uids)`). Clients/jobs/employees come from in-memory facade caches (`PentaClients.getClient`, `PentaJobs.getById`, `PentaEmployees.getById`) — sync, no extra network round trips.
- Returns:
  - `summary` — HTML-escaped one-line story with `<strong>` highlights
  - `chips` — array of `{ label, color, bg }` for inline status pills (issue type, incident type, status, ding target, photo indicator)
  - `drill` — `{ type, id }` for click-to-drill (`type` ∈ `client | job | employee`), or `null` when no natural target

**Renderer dispatch:** big switch on `entity_type` × `action_type`. Covered combinations: `job_issue` (created/resolved/updated), `incident` (created/resolved/updated → reads status transitions out of the diff), `client` (created/updated/deleted/restored), `job` (created/cancelled/updated/started/ended/deleted/restored — `updated` specializes time-only / team-only / date-only diffs to read like "moved 10:00 AM → 9:00 AM"), `application` (submitted), `time_entry` (created/updated, reads clock_in_at / clock_out_at humanly), `lunch_break` (started/ended), `daily_assignment` (assignment changes), `employee` (CRUD with diff), `payment` (created/refunded), `system` (manual_note + Maids Sync `approved` events). Unknown combinations fall back to a generic verb + entity_type label.

**Diff detection on `updated`:** `_audDiffFields(old, new)` walks both jsonb objects, skips noise fields (`updated_at`, `created_at`, `last_seen_at`, version/audit columns, signed photo URLs), and returns the top 3 changed fields with friendly labels via `_AUDIT_FIELD_LABEL` (e.g. `fc → 'frequency'`, `pkg → 'package'`).

**Click-to-drill:** rows render with `data-audit-drill-type` + `data-audit-drill-id` attributes. `_wireAuditDrill(container)` attaches one delegated click listener that dispatches to `openClientEdit`, `openJobModal`, or `openStaffMember`. Idempotent — guarded by `container.__auditDrillWired`.

**Empty-value handling:** `(deleted client)`, `(former staff)`, `(unknown)` appear when a referenced id no longer resolves in the local cache. Drill is suppressed when the resolved target is missing.

**Backward compat:** the pre-Build-1 `_auditDescribe(row)` helper still exists as a shim that text-strips the new renderer's HTML output. Any legacy caller that hadn't migrated keeps working.

---

## 8b. Incidents (v11.0.12 — Phase B)

`incidents` is the liability-track event stream — distinct from `job_issues` (Phase A) by severity, photo support, and a four-step status workflow. Replaces the legacy localStorage `cleanco_pending` write that the employee Report Incident form used.

**Surfaces:**
- **Employee** (Report Incident modal on the schedule job card) — `incident_type` dropdown, description textarea, optional photo, Submit. Goes through `PentaIncidents.report()`. Photo uploaded to Storage; row inserted in `public.incidents`.
- **Manager** (Schedule job card body, expanded view) — Incidents section below Issues. Open + in_review at top with status `<select>` dropdown + "View photo" lightbox link. Resolved + closed dimmed below.
- **Client profile** — same row layout listing all incidents for that client (Phase B continues into the client card UI work).

**Incident types** (CHECK-constrained): `property_damage`, `injury`, `vehicle_accident`, `client_complaint`, `pet_issue`, `safety_hazard`, `other`.

**Status workflow:** `open → in_review → resolved | closed`. CHECK-constrained. Status changes auto-stamp `status_changed_at` + `status_changed_by` via the `incidents_set_updated_at` BEFORE UPDATE trigger.

**Photo storage:** Supabase Storage bucket `incident-photos` (private, 10MB limit, JPEG/PNG/WebP/HEIC). Path convention `<business_id>/<incident_id>/photo.<ext>`. RLS via `storage.objects` policies (mig 051): SELECT/INSERT for same-business members, UPDATE/DELETE for manager-tier. Photo URLs minted as short-lived signed URLs via `PentaIncidents.getSignedPhotoUrl(90s)` for every view. `photo_url` cached on the row is a 90-day signed URL (convenience only — fresh signed URLs are the authoritative path).

**Audit:** `audit_log_capture()` writes `action_type='created'` on INSERT and `action_type='resolved'` on `status` → `'resolved'` transition. Other UPDATEs use the generic `'updated'` path. `entity_type='incident'` (both vocabulary additions CHECK-constrained in mig 050).

**Combined badge (v11.0.12):** The Schedule home tile + dock badge shows ONE combined count: `PentaJobIssues.countUnresolved() + PentaIncidents.countOpen()`. Open + in_review incidents both contribute. Per-card surfacing differentiates by section: yellow Issues vs red Incidents.

---

## 8a. Job Issues (v11.0.9 — Phase A)

`job_issues` is the manager-facing event stream for "something went wrong at this job". Replaced a localStorage-backed STUB flow where one branch (`notifyClient`) was a hardcoded `Demo: simulate sending SMS to client` toast.

**Surfaces:**
- **Employee** (Schedule tab → job card) — Report Issue sheet with 5 typed options. Tap → row inserted via `PentaJobIssues.report(...)`. No client SMS. Unresolved issues render as yellow chips below the address.
- **Manager** (Schedule tab → job card, both inline and modal) — red dot on the colored header band when unresolved count > 0; Issues section in the card body lists unresolved with a Resolve button per row + resolved history below dimmed. Schedule home tile carries a red-dot badge with the tenant-wide unresolved count via `PentaJobIssues.countUnresolved()`.

**Issue types** (CHECK-constrained): `locked_out`, `no_one_home`, `cant_find_house`, `forgot_key`, `running_late`.

**ding_target** is set at insert time and snapshotted. It's the anchor for the future Service Quality Score (client side) and Team Health Score (staff side):

| issue_type | within_window | ding_target |
|---|---|---|
| locked_out, no_one_home | true (±1hr of `scheduled_start_at`) | `client` |
| locked_out, no_one_home | false (we arrived too early or too late) | `none` |
| cant_find_house | (n/a) | `none` (on us but not punitive) |
| forgot_key, running_late | (n/a) | `staff` |

`within_window` and `scheduled_start_at` are computed in `PentaJobIssues.report` from `j.date + 'T' + j.time` in local time, never recomputed after insert.

**Resolution:** manager-only. Manager taps Resolve on the card → optional `resolution_note` prompt → `PentaJobIssues.resolve(issueId, note)` sets `resolved_at`, `resolved_by`, `resolution_note`. No DELETE path — `job_issues` is append-only via the same RLS pattern as `audit_log`.

**Audit:** the `audit_log_capture()` trigger detects `resolved_at` NULL→NOT NULL transition and writes `action_type='resolved'` (mirrors the `jobs.cancelled_at` handling). INSERTs write `action_type='created'`. `entity_type='job_issue'`. Both vocabulary additions are CHECK-constrained.

---

## 9. Migration log

Tenant-relevant migrations (most recent first; full list under `/migrations`):

- **051** — `incident-photos` Storage RLS policies on `storage.objects`: same-business SELECT/INSERT, manager-tier UPDATE/DELETE. Bucket itself created by tenant admin via Dashboard (private, 10MB, image/* MIME)
- **050** — `audit_log` extension for `incidents`: adds `'incident'` to entity_type CHECK, extends `audit_log_capture()` to detect `status` → `'resolved'` transition, attaches trigger to `public.incidents`
- **049** — `incidents` table (Phase B) + RLS + indexes + `incidents_set_updated_at` BEFORE UPDATE trigger (bumps `updated_at` + auto-stamps `status_changed_at`/`status_changed_by` on status changes). Drops a legacy zero-row `incidents` table with a different schema first
- **048** — `audit_log` extension for `job_issues`: adds `'resolved'` to action_type CHECK, `'job_issue'` to entity_type CHECK, extends `audit_log_capture()` to handle `resolved_at` NULL→NOT NULL, attaches the trigger to `public.job_issues`
- **047** — `job_issues` table + RLS (same-tenant SELECT/INSERT/UPDATE) + indexes (unresolved partial index on `business_id`, `(business_id, job_id)`, partial `(business_id, client_id)`)
- **046** — Audit trigger fix: replaced reference to non-existent `jobs.cancelled` boolean with `cancelled_at` NULL→NOT NULL transition detection
- **045** — `sync_reports` table (per-(tenant,date) state) + `get_daily_sync_data` + `mark_sync_report_synced` RPCs (Maids Sync Report Phase 1)
- **044** — `submit_job_application` RPC supplement: writes a richer `'submitted'/'application'` audit_log row alongside the trigger's auto-fired `'created'` event
- **043** — `audit_log_capture` trigger function attached AFTER INSERT/UPDATE/DELETE to 8 tenant-scoped tables: `jobs`, `clients`, `employees`, `payments`, `job_applications`, `time_entries`, `lunch_breaks`, `daily_assignments`. Filters noise (skips updates that only touch `updated_at`) and derives semantic action types (`cancelled`, `started`, `ended`, `restored`, `deleted` soft vs hard)
- **042** — `audit_log` schema hardening: CHECK constraints on `action_type` (15 allowed) + `entity_type` (12 allowed); 3 indexes (`(business_id, created_at DESC)`, `(business_id, entity_type, entity_id, created_at DESC)`, BRIN on `created_at`); role-gated SELECT triple (manager-tier sees all, dispatcher sees scheduling-related, employee sees own); INSERT WITH CHECK requiring `user_id` NULL or = caller's `users.id`
- **041** — `client_keys` UNIQUE INDEX on (business_id, client_id) + backfill of 59 rows from retired CLIENT_KEYS const
- **040** — `business_offices` table + RLS (Issue A)
- **039** — `business_phone_integrations` table + RLS + `get_active_phone_integration` / `mark_phone_integration_used` / `mark_phone_integration_error` RPCs
- **038** — `aggregation_snapshots` SELECT restricted to authenticated role
- **037** — `businesses.slug` + `get_business_by_slug` + `submit_job_application` RPCs + revoke anon INSERT on `job_applications`
- **036** — Harden `job_applications_public_insert` WITH CHECK
- **034** — Extend `get_business_teammates` to include `is_driver`
- **033** — Extend `get_business_teammates` to include `team_text`/`team_id`
- **032** — `time_entries` + `jobs.actual_start_at/end_at` + `set_job_actual_time` RPC
- **031** — `get_business_teammates` active-only filter
- **030** — `get_business_teammates` initial SECURITY DEFINER teammate display RPC
- **029** — Rewards system gifting (`gift_out`, `gift_in`)
- **027** — Rewards system schema

---

## 10. Adding new features safely

When you add a new table or new feature, run through this checklist:

1. **Does the table hold tenant data?** Add `business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE`.
2. **Enable RLS:** `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.
3. **Add four policies** following the standard pattern (SELECT/INSERT/UPDATE/DELETE), each using `auth_belongs_to_business(business_id)`. Add role gating (`u.role IN (…)`) for manager-only operations.
4. **Test cross-tenant:** sign in as a user from a different business and confirm you can't read or write.
5. **No client-supplied `business_id` on writes** — derive from the user's session via RLS WITH CHECK, or use a SECURITY DEFINER RPC.
6. **For public anon surfaces:** route through a SECURITY DEFINER RPC. Never grant anon direct table INSERT.
7. **For storage objects:** path-prefix with `business_id`. Add bucket RLS to enforce.
8. **Never read tenant identity from the browser.** Always trust `auth.uid()` server-side via `auth_belongs_to_business` or its equivalents.

This document supersedes any architectural assumptions in older roadmap entries.
