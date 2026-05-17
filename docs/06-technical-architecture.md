# Penta — Technical Architecture

This document captures the runtime + data architecture of Penta as of v11.0.0 (May 11, 2026). It is the canonical reference for how multi-tenancy works, where security boundaries sit, and what is and isn't safe to assume when adding new features.

Update this document whenever the foundational architecture changes (auth flow, tenancy model, RLS pattern, Claire's scope, etc.). Do not update it for routine product features.

---

## 1. Stack overview

- **Frontend:** Single-page web app delivered as one large `index.html` (~38k lines, embedded `<script>`). Hosted on GitHub Pages today (`https://captainclean115-oss.github.io/cleaningapp/`). PWA in spirit, not yet packaged native.
- **Database:** Supabase Postgres (project ref `wymoezilyjmyibmuqqmr`). Single shared schema (`public`).
- **Auth:** Supabase Auth. JWTs in localStorage. `auth.uid()` is the integration point between the browser session and Postgres.
- **Server-side compute:** Supabase Edge Functions (Deno). Functions live today: `accept-invite`, `set-employee-password`, `translate-chat`, `translate-message`, `send-sms`, `rc-inbox`, `rc-mark-read`.
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
| `send-sms` (v15, mig 062) | JWT required | Server-side SMS send. Resolves caller tenant from JWT, looks up `business_phone_integrations` row, branches on `credentials.auth_method` (`oauth` refresh-token flow vs `jwt` bearer-grant flow; missing → defaults to `oauth`). Env-source fallback always treated as `oauth`. In-memory access-token cache per `(businessId,authMethod)` for ~50min. Rate-limited 200/hr + 1000/day per caller via `check_rate_limit_dual`. Recipient gated to clients/employees of the tenant unless `allow_unknown_recipient: true` is set. Returns 424 when no integration configured |
| `rc-inbox` (v8, mig 062) | JWT required | Server-side SMS inbox reader for RC. Same auth-method branching + token cache as `send-sms`. Paginated GET against `/message-store?messageType=SMS` (perPage 250, 20-page cap). Rate-limited 60/hr. Projects RC's wide message shape to a 7-field subset before returning to the browser |
| `rc-mark-read` (v8, mig 062) | JWT required | Marks one RC message as Read via PUT to `/message-store/<id>`. Strict 1-32 digit regex on the message id blocks path injection. Same auth-method branching + token cache. Rate-limited 600/hr (a thread of 20 unread bursts on open) |

Edge Functions verify the caller's JWT and resolve tenant via `users.business_id` server-side. They do not trust browser-supplied tenant ids.

### Per-tenant phone provider integrations (v11.0.2)

Schema (Migration 039):

`business_phone_integrations` — one row per (business_id, provider). Columns: `provider` (check constraint: `ringcentral | text_request | twilio`), `phone_number_e164`, `credentials jsonb` (provider-specific shape), `status` (`active | disconnected | error`), `last_used_at`, `last_error`, soft delete. UNIQUE index on (business_id, provider) WHERE not deleted.

RLS gates the table to owners + admins for SELECT / INSERT / UPDATE / DELETE. Managers and below cannot read raw credentials — they invoke `send-sms` which uses service_role internally.

RPCs (all SECURITY DEFINER):
- `get_active_phone_integration(business_id, provider) → (phone_number_e164, credentials, status)` — used by the EF and the manager Settings status line.
- `mark_phone_integration_used(business_id, provider)` — service-role write after successful send. Resets status to active.
- `mark_phone_integration_error(business_id, provider, error_text)` — service-role write on failure. Sets status='error', stores last_error truncated to 500 chars.

For RingCentral, the `credentials` JSONB carries one of two shapes, distinguished by `auth_method` (mig 062):

- **OAuth (legacy):** `{auth_method: "oauth", client_id, client_secret, refresh_token}` — server posts to `/oauth/token` with `grant_type=refresh_token`. RC rotates the refresh token on every call, so concurrent refreshes from multiple clients invalidate each other (OAU-213). Safe only when all refreshes happen server-side from a single Edge Function pool.
- **JWT bearer-grant (recommended):** `{auth_method: "jwt", client_id, client_secret, jwt_credential}` — server posts to `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`. The JWT credential is generated in the RC developer console and tied to a specific RC user; it's long-lived (no rotation), so concurrent server use is fully safe. Revoke from the same RC console page if compromised.
- **Env-source (transitional):** `{source: "env"}` — EF reads `RC_CLIENT_ID` / `RC_CLIENT_SECRET` / `RC_REFRESH_TOKEN` env vars and always treats them as OAuth. Manna Maids' early state during the v11.0.2 migration.

For **`provider: 'native_sms'`** (PR2 of SMS strategy, mig 063), the `credentials` JSONB is empty `{}`. Every dispatch site opens a `sms:NUMBER?body=ENCODED` URI to hand the message off to the user's native SMS app (iOS Messages / Android default). No Edge Function is invoked. The inbox is unavailable — replies come back to the user's phone, not into Penta. The Messages tab shows a "📱 Manual SMS mode" notice instead of the inbox list.

Missing or unknown `auth_method` defaults to `oauth` so every row that existed before mig 062 keeps working. Tenants flip from OAuth → JWT, or RC → Native SMS, via the Admin → Phone & SMS settings modal — pick the provider + auth method in the dropdowns, fill the relevant credentials (if any), save. The same modal has a Test button that routes through `_sendSMS` (the canonical dispatch helper) so it exercises the actual path every other site uses.

#### Provider × auth_method behavior matrix

| provider     | auth_method | dispatch sites             | inbox                  | mark-read              | browser OAuth flow |
|--------------|-------------|----------------------------|------------------------|------------------------|--------------------|
| `ringcentral`| `oauth`     | `send-sms` EF (oauth)      | `rc-inbox` EF          | `rc-mark-read` EF      | gated alive (rcInit, rcConnect, _rcDoRefresh keep working for the legacy refresh-token flow) |
| `ringcentral`| `jwt`       | `send-sms` EF (jwt)        | `rc-inbox` EF          | `rc-mark-read` EF      | dead — rcInit early-returns, Connect button hidden |
| `native_sms` | (n/a)       | `sms:NUMBER?body=…` URI    | not available (notice) | not available          | dead — same as JWT |
| (none)       | (n/a)       | 424 "no integration"       | "not configured" notice | n/a                    | dead — Connect hidden |

Routing decisions are read once at boot via the new SECURITY DEFINER RPC `get_phone_provider_summary` (mig 064), which returns only `(provider, phone_number_e164, status, auth_method)` — never credentials. `authenticated` role can call it (not just owner/admin) because every user-facing dispatch site needs to know which mode to use. Cached in `window.PentaPhone` for synchronous reads from inside dispatch sites; refreshed when the admin modal saves new settings.

`_sendSMS(phoneE164, body, opts)` is the single canonical dispatch helper — every send site in `index.html` routes through it, never inline. Branching:
- `provider === 'native_sms'` → `window.location.href = 'sms:N?body=...'`
- else → `supabaseClient.functions.invoke('send-sms', ...)` which handles oauth vs jwt server-side

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

## 8j. Forms surfaces (v11.0.25)

Employee form submissions (`public.forms`, Sprint 8) were already saving to DB but had no manager-side cross-device surface. The Sprint 8 `submitForm` path wrote a row to `forms` AND a localStorage entry to `cleanco_pending` — but the localStorage entry lived on the employee's phone, so managers on different browsers never saw the form arrive in their Updates tab. v11.0.25 adds three DB-backed surfaces + audit log integration so forms are visible the same way every other entity in the master data log is.

**Audit integration** (mig 059):
- Adds `'form_submission'` to `entity_type` CHECK.
- Extends `audit_log_capture()`: INSERT → `action_type='submitted'`, status `pending→approved` → `'approved'`, status `pending→denied|rejected` → `'rejected'`. `'submitted'`, `'approved'`, `'rejected'` were already in the action_type CHECK from mig 042.
- Trigger attached to `public.forms`.

**Updates tab — Incoming Forms inbox**: new section between the existing pending list and Manual Tasks. Reads `PentaForms.listSync()` filtered to `status='pending'`, sorted newest-first. Each row shows the form-type icon, employee name + team, brief details (Reason / What / Notes truncated), submission time, and a `[Review]` button that opens the existing staff edit overlay with `showStaffTab('forms')` queued. Pill in the section header shows the pending count.

**Dock Updates badge** (`updateTaskBadge`): now includes the pending-forms count alongside `pendingUpdates` + `manualTasks`. Sourced from `PentaForms.listSync()` (DB-backed via PentaForms's existing realtime channel), so a form submitted from an employee's phone increments the manager's badge live without refresh.

**Employee profile Recent Forms preview**: new card on the top-level staff View tab (not buried in the Forms sub-tab). Shows the last 5 forms for that employee with status pills (PENDING amber / APPROVED green / DENIED red). Tap any row → opens the Forms sub-tab. Full forms list still lives inside the sub-tab.

**Realtime**: `PentaForms.onChange` callback (existing) now also calls `renderFormsInbox()`, `updateTaskBadge()`, and `renderStaffViewFormsPreview()`. The PentaForms realtime channel was already wired in Sprint 8; this just hooks the new surfaces in.

**Activity Log + Employee Activity section**: `_buildSyntheticAuditRow` handles `entity_type='form_submission'` so the existing `_renderAuditRowSummary` + `_renderStaffActivitySection` pipelines paint form rows with `[FORM: TIME OFF REQUEST]` / `[APPROVED]` / `[DENIED]` chips. `_renderStaffActivitySection` now also queries `PentaForms.listSync()` filtered by `employee_id`.

This brings forms in line with the other 5 master-data-log entities: job_issues (mig 047), incidents (mig 049), payments (mig 052), client_requests (mig 055), chat_messages (mig 057). All share `audit_log_capture`, `_buildSyntheticAuditRow`, `_renderAuditRowSummary`, and the synthetic-audit-row render pipeline.

---

## 8i. RingCentral cross-device token rotation (v11.0.24)

RingCentral rotates the OAuth refresh token on every successful refresh. Each device caches a copy in `localStorage`; PentaSettings mirrors it to `users.settings.rc_refresh` so all of a user's devices share the latest value at boot. But after the initial mirror, each device's local copy drifts independently — and when the laptop refreshes while the phone is open, the phone keeps using the stale token and gets `invalid_grant` next time it refreshes → unexpected `rcLogout`.

**v11.0.24 fix** in `rcRefreshToken`:

1. **DB-first read** in a new `_rcDoRefresh()` helper. The refresh_token is read from `PentaSettings.get('rc_refresh')` first, falling back to `localStorage` only when the cache is empty. The DB copy is mirrored back to `localStorage` so subsequent reads agree.
2. **Single retry on `invalid_grant`**. When RC returns 400 with `error=invalid_grant` (the canonical "another device just rotated this token" signal), we call `PentaSettings.load()` — which fires a fresh DB read and refreshes the in-memory cache — wait 800ms for any in-flight rotation from another device to land, and try the refresh once more. If the retry succeeds, the user stays signed in. If it fails again (genuine expiry / revocation), `rcLogout()` fires as before.
3. **Empty inbox no longer bounces to Connect** in `loadInbox`. Previously `records.length === 0` painted the Connect button as if auth had failed; now an empty inbox renders an empty-list state and the connection status stays "Connected ✓".

Race window between attempt 1 and attempt 2 is bounded by the 800ms wait + the DB roundtrip latency. The `_rcRefreshPromise` in-flight cache (v9.5.6) still dedups parallel refreshes inside one browser; v11.0.24 closes the same race across devices.

---

## 8h. Chat persistence (v11.0.20 — Phase D)

Manager ↔ employee chat moved off `localStorage.cleanco_staff_chats` (which only worked when both parties used the same physical browser) onto a real `public.chat_messages` table with multi-tenant RLS, realtime cross-device delivery, and an audit_log trigger.

**Schema** (mig 057):
- `id`, `business_id`, `thread_employee_id` (FK employees), `sender_user_id` (FK users), `sender_role` ('manager'|'employee')
- `text`, `lang` ('en'|'es'|'pt'|'cv'), `tx jsonb` (pre-computed translations for all four langs)
- `urgent boolean`, `read_at_admin`, `read_at_emp` (independent read receipts per side)
- Indexes: thread+timestamp, partial-index on unread-admin, partial-index on unread-emp
- In `supabase_realtime` publication for cross-device delivery

**RLS** (mig 057):
- Two SELECT policies (OR'd): manager-tier (owner/admin/manager/dispatcher) sees all tenant threads; employee sees only their own thread via `employees.auth_user_id = auth.uid()`
- INSERT: same-tenant + `sender_user_id = caller's users.id`
- UPDATE: same-tenant (only used to mark read_at_*)
- No DELETE — chat is immutable

**Audit trigger** (mig 058) extends `audit_log_capture()`:
- INSERT → `action_type='created'`, `entity_type='chat_message'`
- UPDATE where ONLY `read_at_admin` / `read_at_emp` changed → skipped (no audit log noise from read receipts)
- Other UPDATE → `'updated'`

**Edge Function** `translate-message`: one server call returns translations into all four langs. Caller passes `{text, sourceLang: 'auto'|'en'|…, targetLangs: ['en','es','pt','cv']}`; server detects source if `auto`, returns `{tx: {en, es, pt, cv}, detected}`. Replaces the previous two-step path (browser→Anthropic-direct for English pivot, then per-lang Edge Function call), which was broken whenever the browser lacked an `anthropic_api_key` in localStorage. Server-held `ANTHROPIC_API_KEY` keeps keys out of every device.

**`PentaChatMessages` facade** (near PentaPayments): `send({threadEmployeeId, text, lang, urgent, senderRole})` (calls translate-message, then INSERTs row); `listThread(employeeId)`; `listMyThreads()` (manager); `listForReporter(userId, daysBack=14)` (for employee profile activity surface); `markThreadRead(employeeId, role)`; `countUnreadForManager()`; `countUnreadForEmployee(employeeId)`; `subscribeToTenantUpdates(cb)` + `subscribeToThread(employeeId, cb)` (realtime); `backfillFromLocalStorage()` (one-time legacy migration).

**Realtime delivery**: `pentaPrimeChat` IIFE subscribes once on auth-ready. Manager receives all tenant INSERTs; employees automatically receive only their thread's events (RLS filters realtime payloads server-side). Callback refreshes home tile badge + repaints inbox if visible + appends to open conversation.

**Surfaces touched**:
- **Manager Messages tab** (Staff sub-tab): `renderStaffInbox` reads `listMyThreads`; row preview uses `translatedText(last, adminLang)`. Opening a thread calls `markThreadRead('manager')`.
- **Employee Chat tab** (portal): `renderEmpChat` reads `listThread(currentEmployee.id)` and merges with local AI thread (AI Q&A remains localStorage-only, distinct UX from manager chat). Opening marks `read_at_emp`.
- **Manager home tile** (Messages): synchronous badge reads `window._pentaManagerChatUnread`, populated by `refreshManagerChatBadge` on boot + realtime + visibility.
- **Employee chat-tab badge** (`#ptab-chat-badge`): `countUnreadForEmployee`.
- **Activity Log renderer** (`_renderAuditRowSummary`): new `chat_message` branch — "Viviana V messaged the manager: '…'" / "Tom messaged Viviana V: '…'", with `[CHAT]` chip (purple) + `[URGENT]` chip (red) when applicable.
- **Employee profile Activity section** (`_renderStaffActivitySection`): now also lists chats sent by this employee in the last 14 days (via `_buildSyntheticAuditRow('chat_message', row)`).

**One-time localStorage backfill**: `pentaPrimeChat` calls `backfillFromLocalStorage()` once per browser. For each thread keyed by employee id (or resolvable legacy_roster_id), each message gets re-inserted with `sender_role` inferred from `m.from`, `lang`/`tx` preserved, `created_at` set from the original `ts`. AI messages skipped. On success, `cleanco_staff_chats` is cleared. Flag `chat_localstorage_backfilled_v1` prevents re-runs. **Cross-browser duplicates are possible** if the same legacy thread exists in multiple browsers' localStorage — acceptable given the small surface (manager logs in from one device typically).

The chat_messages table is the 5th entity in the master data log architecture, joining job_issues (mig 047), incidents (mig 049), payments (mig 052), and client_requests (mig 055) — all of which share the same `audit_log_capture` trigger, the same `_buildSyntheticAuditRow` adapter, and the same renderer fanout via `_renderAuditRowSummary` / `_renderStaffActivitySection`.

---

## 8g. Hours Report data source (v11.0.19, v11.0.21, v11.0.22, v11.0.23)

**v11.0.23 — Geotab boundary detection.** Day-start was naively "first trip after 7am," so a quick depot-bounce (gas run, forgot supplies) before the real day-start landed the timer too early. Day-end was already the latest depot arrival, but the algorithm was rewritten alongside the start for clarity.

New rules (Tom's spec):
- **Day start** = the LAST depot-departure trip whose next return-to-depot is sustained (≥ 90 minutes away, or never returns). Walk depot-departures in chronological order; the first one that begins a sustained-away stretch is the start. A quick gas run (depot → gas → depot in 30 min) gets skipped; the subsequent legit work-start departure is picked. A legit mid-day resupply (depot → first job 3 hrs → depot → second job 3 hrs) still picks the first 8am departure because its away-stretch is already sustained.
- **Day end** = the LAST depot arrival after day-start. If the team goes back to the office at 4:30, leaves for a final errand, and returns at 5:00, the day ends at 5:00. If they never returned to depot today, fall back to the latest trip stop (worked off-site / drove straight home).

Fallback chain when depot detection fails (offices table incomplete or address mismatch): legacy "first trip after 7am" for start, "latest trip stop" for end.

The sanity check (`2 ≤ totalHrs ≤ 15`) is retained so Geotab garbage rows are silently dropped.

This is the Geotab pathway only — used for teams without time_entries data or as the supplementary lunch-detection layer on top of time_entries. `time_entries` clock-in/out remains authoritative for teams using the employee portal.



**v11.0.22 — UI rewrite.** The dense `<table class="hours-table">` is replaced with iOS-style team cards + collapsible employee rows that match Penta's overall design language. Each team gets a card with a colored header strip, employees stacked inside, and tap-to-expand 5-day breakdowns per employee. Day pills show hours + start/end + lunch + live indicator. Off-team days render with a tooltip showing where the employee actually was. CSS class set: `.hrs-team-card`, `.hrs-team-head`, `.hrs-emp-row-wrap`, `.hrs-emp-row`, `.hrs-emp-avatar`, `.hrs-days`, `.hrs-day`, `.hrs-totals-bar`, `.hrs-export-btn`. Expanded state persisted in `window._hrsExpandedEmps` so the 60s live refresh doesn't collapse open rows. The CSV export logic is unchanged.



**v11.0.21 — strict per-day team membership.** The Hours Worked table on the Live tab now reflects exactly who was on each team per day (via `daily_assignments`), not who that team's permanent members are.

Previously two bugs caused hours to double-count and to render under the wrong team:

1. The team-row filter included `|| e.defaultTeam === team`, pulling employees into their permanent team's row regardless of daily moves. An employee moved from B1 → S1 for the whole week still appeared under B1 and S1.
2. Each row's per-day cells rendered hours regardless of which team that employee was actually on for that day, so the same hours appeared in two rows.

The fix drops the default-team fallback from the filter and gates per-cell rendering on `getEmployeeTeam(empId, dateKey(d)) === team`. On days an employee is not on this team, the cell is em-dash (with a tooltip showing where they were). Hours never double-count. Per-team week totals and per-day totals (`depotTotals`) sum only the cells where the employee was on that team.

`getEmployeeTeam` still falls back to `defaultTeam` when there's no daily_assignments override for the date — so unchanged employees stay on their permanent team naturally. Only explicit moves (or 'OFF' rows) shift the cell location.

The same change applies to the `showHoursReport` export so on-screen + exported numbers match cell-for-cell.



Previously, the Hours Report rendered exclusively from the MyGeotab Trip API. When Geotab auth failed (rotating credentials, network outage, single-tenant hardcoded session), the manager view showed empty team headers with "No GPS data this week" beneath each, even though Penta's own `time_entries` table held real clock-in/out data.

**New flow** — `loadWeekHours()` reads `time_entries` from Supabase first; Geotab is supplementary.

1. **Primary**: query `public.time_entries WHERE business_id = current AND clock_in_at IN [week_start, week_end] AND deleted_at IS NULL`. Group rows by `employees.team_id` → `teams.name`. Build:
   - `weekHours[team] = { days[5], starts[5], ends[5], lunch[5], total, source: 'time_entries' }` — per-team aggregate, used by export + edit modal for backward compat.
   - `window._empHoursMap[empId][YYYY-MM-DD] = { hours, start, end, openShift }` — per-employee cell map, primary source for the renderer's per-row cells.
2. **Supplementary**: best-effort `gpsAuthenticate()` + `geotabCall('Get', {typeName:'Trip'})`. If auth fails, silently skip — the time_entries data still renders. If trips arrive:
   - `window._hoursGeotabAvailable = true` → renderer shows a 📍 **GPS** badge on team headers sourced from Geotab.
   - Existing lunch-detection logic runs (stop between 10am–4pm, not at depot, not a scheduled client) and writes into `weekHours[team].lunch[i]`.
   - Geotab does **not** overwrite time_entries data for teams already populated from clock-ins. Teams without clock-in rows fall back to Geotab-derived hours (source: `'geotab'`).
3. **Open shifts**: rows with `clock_out_at IS NULL` are computed as `now - clock_in_at`, marked `openShift: true`. Renderer paints a `● live` indicator in green on that cell. A 60s `setInterval` re-runs `loadWeekHours` while the GPS view stays active and the user is on the current week.

The Hours Worked block now lives as a sibling of `#gps-main-section` (not inside it) so it renders even when MyGeotab is not connected. `gpsInit()` unconditionally calls `loadWeekHours()`.

**Geotab cleanup still deferred** — credentials are hardcoded to Manna Maids (`tommanna28@gmail.com`/`Maids2022!`) and shared across tenants. A per-tenant `business_geotab_integrations` table modeled after Phase B-2's `business_phone_integrations` is required before the GPS map surface works for non-Manna tenants. Not in scope for v11.0.19.

---

## 8f. Client Requests (v11.0.17 — Phase B.5)

Lightweight operational capture distinct from incidents and job_issues. Employee relays a request from the client (skip next clean, reschedule, change frequency, etc.); manager acknowledges. No photos, no status workflow — single `acknowledged_at` NULL→NOT NULL transition.

**Six request types** (CHECK-constrained): `skip_next_clean`, `add_service_today`, `reschedule`, `change_frequency`, `general_message`, `other`. Description text is required only when type=`other`.

**Audit trigger** (mig 056) extends `audit_log_capture()`:
- INSERT → `action_type='created'`, `entity_type='client_request'` (new entity value, CHECK-constrained)
- UPDATE `acknowledged_at` NULL→NOT NULL → `action_type='acknowledged'` (new action value, CHECK-constrained)
- Other UPDATE → `'updated'`

**`PentaClientRequests` facade** near `PentaIncidents`: `report({jobId, clientId, requestType, description})`, `listForClient`, `listForJob`, `listForReporter`, `listUnacknowledged`, `countUnacknowledged`, `acknowledge(id, note)`.

**Surfaces** (re-using the Build 1 renderer pipeline via `_buildSyntheticAuditRow`):

- **Employee TL action grid**: new 📝 **Request** button restored the 2×2 grid (Issue / Incident / Payment / Request). Opens `#client-request-sheet` — 6 type chips + free-text description.
- **Manager job card**: new Client Requests section painted by `_mgrPaintJobRequests`, below Payments. Unacknowledged rows at top with **Acknowledge** button + optional note prompt; acknowledged rows dimmed below.
- **Client History** (Build 2 §8d) now includes requests alongside issues/incidents/payments.
- **Employee Activity** (Build 2 §8d) now includes requests reported by that employee.
- **Open Items view** gains a 4th tab **Requests**. Same oldest-first sort. Inline Acknowledge button on each row.
- **Combined badge** on Schedule dock + Schedule home tile + Open Items home tile now sums `unresolved_issues + open_incidents + unacknowledged_requests`.
- **Activity Log** — `_renderAuditRowSummary` renders "Viviana V flagged 'Skip next clean' for Stephanie Weiss — note: '…'" with `[REQUEST: SKIP NEXT CLEAN]` chip on created and "Tom acknowledged Stephanie Weiss's request to skip next clean" with `[ACKNOWLEDGED]` chip on the acknowledge transition.
- **Maids Sync Report** auto-includes requests through `audit_log` (entity_type `client_request`).

`_refreshAllAuditSurfaces` cascades any acknowledge action through all surfaces simultaneously.

---

## 8e. Payment Receive system (v11.0.16 — Phase C)

`public.payments` pre-existed as an empty stub; this phase aligned it with the Phase A/B architectural pattern. Migration 052 renamed three legacy columns (`applied_to_job_id → job_id`, `created_by_user_id → recorded_by`, `vision_extracted_data → ocr_results`), added the missing columns, replaced the legacy method CHECK with the new six-value one, added indexes + RLS policies + a 90-day photo retention default. Migration 053 special-cased the existing audit trigger so payment INSERTs emit `action_type='received'` (not `'created'`) and the `voided` false→true transition emits `'refunded'`. Migration 054 added storage.objects policies for the `payment-photos` bucket.

**Six payment methods** (CHECK-constrained): `cash`, `check`, `venmo`, `zelle`, `credit_card`, `other`. `'other'` carries a free-text label in `payment_method_other`; `'check'` carries the check number in `check_number`.

**Void flow:** payments are append-only. The `voided` boolean + `voided_at`/`voided_by`/`void_reason` mark a payment as voided rather than deleting it. No DELETE policy on the table. Audit trigger emits `action_type='refunded'` on the transition.

**Storage bucket:** `payment-photos`, private, 10MB, image-only MIMEs. Path convention `<business_id>/<payment_id>/photo.<ext>`. RLS via `storage.objects` policies (same tenant for SELECT/INSERT; manager-tier for UPDATE/DELETE). **Tom must create the bucket in Supabase Dashboard before testing photo upload** — text-only payments work immediately.

**Photo required for checks** — `submitJobPayment` enforces this client-side. Other methods can attach a photo optionally.

**OCR future-proofing (Phase D, deferred):** `ocr_results` (jsonb), `ocr_status` (CHECK: pending/verified/mismatch/skipped), `ocr_confidence`, `ocr_processed_at` are reserved for a future Edge Function that reads check photos via Claude vision. No app code references them yet.

**`PentaPayments` facade** (near `PentaIncidents`): `record({jobId, clientId, paymentMethod, paymentMethodOther, amount, checkNumber, memo, photoFile, receivedAt})` → uploads photo first, inserts row; `listForClient(clientId, {includeVoided})`; `listForJob(jobId)`; `listRecent(daysBack)`; `void(paymentId, reason)`; `getSignedPhotoUrl(photoPath)` (fresh 90s signed URL).

**Surfaces:**
- **Job card (manager, expanded)** gains a Payments section painted by `_mgrPaintJobPayments` — live payments at top, voided dimmed with strikethrough below. Manager can void from this row (button + reason prompt).
- **Client profile History** (Build 2 §8d) now also includes payment rows via the synthetic-audit-row adapter (`entity_type='payment'`).
- **Activity Log** — `_renderAuditRowSummary` payment branch renders "Viviana V recorded $185 check payment from Stephanie Weiss · check #4811" with `[📎 PHOTO]` chip when photo_path is set, and "Tom voided $185 cash payment from Stephanie Weiss — reason: '…'" + `[VOIDED]` chip on refund.
- **Maids Sync Report** automatically picks up payment events through audit_log (no surface-specific code change needed — the report consumes audit_log entity_type='payment' filtered by date).

Payments do NOT appear on the Open Items home tile — they're transactions, not open items.

---

## 8d. Surfacing incidents + job_issues across the manager UI (v11.0.15 — Build 2)

Phase A/B captured the data; Build 2 surfaces it where managers actually look. Three new surfaces, all share the Build 1 renderer pipeline via a small adapter:

**`_buildSyntheticAuditRow(entityType, row)`** — maps a native `job_issue` or `incident` row into the `audit_log` shape (`{ user_id, action_type, entity_type, entity_id, new_values, old_values, created_at }`) so `_renderAuditRowSummary` renders the row identically to the corresponding audit_log entry. For records that are already resolved/closed, the synthetic row emits `action_type='resolved'` so the chip reads "RESOLVED" not "OPEN" (and the time reflects when it was resolved, not reported).

**Surface 1 — Client profile `openClientEdit`** gains a "History" section painted by `_renderClientHistorySection(clientId, hostId)`. Reads `PentaIncidents.listForClient(clientId)` + new `PentaJobIssues.listForClient(clientId)` (added in this build), unions them, sorts newest-first, renders via the synthetic-audit pipeline. Inline status dropdown for incidents + Resolve button for unresolved issues — wired to the existing `_mgrChangeIncidentStatus` / `_mgrResolveIssue` handlers.

**Surface 2 — Employee profile `renderStaffView`** gains an "Activity" section painted by `_renderStaffActivitySection(emp, hostId)`. Reads new `PentaIncidents.listForReporter(userId)` + `PentaJobIssues.listForReporter(userId)`. The employee→user_id mapping uses `employees.auth_user_id` (Supabase convention: `users.id === auth_user_id` for accounts created via the auth provider). Read-only — staff Activity intentionally doesn't surface resolve/status controls; managers go to the parent job card.

**Surface 3 — `#open-items-view`** is a new fullscreen overlay (same shape as `#sync-report-view`) with All / Issues / Incidents filter tabs. Sorted **oldest-first** so the rows being ignored longest float to the top. Painted by `_refreshOpenItems()` which is also exposed as `window._refreshOpenItems` so cross-surface refreshes (from `_mgrResolveIssue` / `_mgrChangeIncidentStatus`) can repaint it.

**New home tile: "Open Items"** with `LUCIDE['alert-triangle']` icon + amber gradient. Reuses the combined badge cache `_pentaSchedBadgeCount` so the Schedule dock and the Open Items tile show the same number.

**Cross-surface refresh** — `_refreshAllAuditSurfaces(jobId, clientId)` runs after every `_mgrResolveIssue` and `_mgrChangeIncidentStatus` success. Each branch is guarded so unmounted surfaces no-op cleanly. Together with the existing `renderCal()` + `_refreshSchedTileBadge()` calls, this guarantees a single resolve cascades into:
  1. The collapsed timeline block badge on `#cal-view`
  2. The expanded job card's Incidents section (modal + inline)
  3. The Schedule home tile + dock badge
  4. The Open Items home tile badge
  5. The Open Items view's row list, if open
  6. The client edit modal's History section, if open
  7. The staff profile's Activity section, if open

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
- **064** — `get_phone_provider_summary(business_id)` SECURITY DEFINER RPC. Returns `(provider, phone_number_e164, status, auth_method)` to any authenticated tenant member so browser can route `_sendSMS` without seeing credentials. PR2 of SMS strategy.
- **063** — Extend `business_phone_integrations.provider` CHECK to include `'native_sms'`. Adds the manual-SMS fallback mode where dispatch sites open the user's native SMS app. PR2 of SMS strategy.
- **062** — `business_phone_integrations.credentials.auth_method` JSONB key + backfill existing OAuth rows. Adds JWT bearer-grant support without DDL changes. PR1 of SMS strategy split.
- **061** — `rate_limits` table + `check_rate_limit` / `check_rate_limit_dual` / `cleanup_rate_limits` SECURITY DEFINER RPCs. Used by `send-sms` (200/hr + 1000/day), `rc-inbox` (60/hr), `rc-mark-read` (600/hr), `translate-chat` (300/hr)
- **060** — Harden SECURITY DEFINER helpers with explicit `search_path = public, pg_temp`
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
