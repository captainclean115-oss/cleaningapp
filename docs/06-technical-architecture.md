# Penta — Technical Architecture

This document captures the runtime + data architecture of Penta as of v11.0.0 (May 11, 2026). It is the canonical reference for how multi-tenancy works, where security boundaries sit, and what is and isn't safe to assume when adding new features.

Update this document whenever the foundational architecture changes (auth flow, tenancy model, RLS pattern, Claire's scope, etc.). Do not update it for routine product features.

---

## 1. Stack overview

- **Frontend:** Single-page web app delivered as one large `index.html` (~38k lines, embedded `<script>`). Hosted on GitHub Pages today (`https://captainclean115-oss.github.io/cleaningapp/`). PWA in spirit, not yet packaged native.
- **Database:** Supabase Postgres (project ref `wymoezilyjmyibmuqqmr`). Single shared schema (`public`).
- **Auth:** Supabase Auth. JWTs in localStorage. `auth.uid()` is the integration point between the browser session and Postgres.
- **Server-side compute:** Supabase Edge Functions (Deno). Functions live today: `accept-invite`, `set-employee-password`, `translate-chat`, `translate-message`, `send-sms`, `rc-inbox`, `rc-mark-read`, `get-weather`, `claire-chat`, `geotab-call`.
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
| `get-weather` (v1, feat/weather-edge-function) | JWT required | Proxies OpenWeatherMap `/data/2.5/forecast` so the browser bundle no longer ships an API key. POST `{lat, lon, units}`; returns the raw OpenWeather payload so the existing browser-side `byDay` transform is unchanged. In-memory cache keyed by `(lat,lon,units)` (3-decimal lat/lon for ~110m precision) with 10min TTL, stacks under the browser's 3h `localStorage` cache. Requires `OPENWEATHER_API_KEY` Supabase secret |
| `claire-chat` (v1, feat/claire-edge-function) | JWT required | Server-side proxy for the Anthropic Messages API. Holds `ANTHROPIC_API_KEY` as a Supabase secret so the key never ships in the browser bundle. Pass-through: whatever shape the browser POSTs (`model`, `max_tokens`, `system`, `tools`, `messages`, `stream`) goes upstream verbatim; whatever Anthropic returns (JSON or SSE) pipes back unchanged. Tool loop runs CLIENT-SIDE — browser executes tools, sends `tool_result` back on the next round. Rate limit 300/hr/user (Claire's tool loop fires up to 10 rounds per user message, so 300/hr ≈ 30 messages/hr/manager). All 8 browser sites that used to fetch `api.anthropic.com/v1/messages` directly now route through the single `_claireApi(body)` helper |
| `geotab-call` (v2, feat/geotab-per-tenant-pr2) | JWT required | Server-side proxy for MyGeotab's JSON-RPC API. Reads credentials from per-tenant `business_geotab_integrations` (mig 067). POST `{method, params}`. Method allowlist: `Get`, `GetCountOf`, `GetAddresses` (read methods only; `Add`/`Set`/`Remove` blocked). Authenticates server-side, caches the session (including the post-pivot host returned in `result.path`) per `business_id` in-memory ~50min, retries once on session-expired. Rate-limited 600/hr/user (split pattern from mig 066). **Browser:** all 15 `_geotabCall(method, params)` sites route through this EF; the in-bundle `GEOTAB_USER` / `GEOTAB_PASS` / `GEOTAB_DB` / `GEOTAB_SERVER` constants are gone, the `gpsAuthenticate` / `gpsConnect` browser flow is retired, and `gps_session` / `gps_server` no longer live in localStorage or `PentaSettings.SYNC_KEYS` |
| `poll-geotab-clocks` (v4) | JWT required (`service_role` for `pg_cron`, or an authenticated manager-tier user's own JWT for the "Run poll now" button, re-verified via `auth.getUser` — see mig 076/078) | GPS-as-truth clock-in/out. Fired every 15min by `pg_cron` (`trigger_poll_geotab_clocks()`, mig 076) or on-demand (Admin → Fleet Tracking, scoped to the caller's own tenant only). Per team: resolves the Geotab device via `get_team_device_for_poll` (mig 081, explicit `team_device_assignments` override) falling back to name-matching, fetches the last 30min of trips, geofence-matches stops/starts to jobs (`resolve_job_from_gps_stop`, mig 075/078/079) and office bookends (`write_office_gps_clock`), and writes `jobs.actual_start_at/end_at` (NULL-only, never overwrites a manual clock) + `time_entries` (tagged `source='gps'`, a separate row from any manual entry). Writes are gated per-tenant by `gps_clock_writes_enabled` (default `false` — dry-run/log-only until verified). Duplicate-processing-safe via a `(business_id, device_id, geotab_trip_id, point_type)` unique index (mig 079). Rate-limited 1 poll/5min/tenant; 3 consecutive tenant failures reuses `mark_geotab_integration_error`, the same health indicator `geotab-call` uses |

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

## 8aa. Maids CSV importer (PR #78)

Re-runnable admin tool (Admin panel → "Maids Import") for bringing Tom's 2025/2026 job + client data in from The Maids as the first step of the Manna migration. Matching, mapping, and confidence scoring all happen client-side (JS) before anything reaches the server; the server side is one atomic RPC that trusts an already-resolved payload rather than doing fuzzy matching itself.

**Schema (migration 087)**. `jobs` gained `scheduled_start_time`/`scheduled_end_time` (time-typed, precise — distinct from the existing text `time`/`end_time` columns, which stay populated too for every existing reader), `balance_due`, `actual_minutes` (quoted minutes reuses the existing `duration_minutes`, already treated that way by `PentaJobs`), `cancellation_type` (`company_closure`/`client_initiated`), `team_code_raw` (the original CSV text when it didn't map), `is_multi_visit_day`, and a partial unique index `(business_id, client_id, date, scheduled_start_time)` that's the upsert dedup key. `clients` gained `first_service_date`, `historical_cancellation_count`, `historical_completion_count`, `team_performance` (jsonb, per-team avg actual/quoted ratio), `current_price`, `tags text[]` (segment: `oms_only`/`past_client`/`recurring`/`past_client_marketing_target`), and `review_flags text[]` (manager-attention: `not_in_maids_import`/`needs_address_details` — deliberately separate from `tags` and from the existing `status` enum, which only has `active`/`paused`/`inactive` and couldn't safely carry an import-specific value without corrupting logic elsewhere that branches on it). New `import_runs` table logs every run (mode, counts, timestamp, who ran it) for the Admin "Past Imports" history view.

**The `import_maids_data` RPC** (`SECURITY INVOKER`, owner/admin/manager only) is the only way this data gets written — one Postgres transaction covering: optional full job wipe (danger-zone toggle, off by default), client upserts (matched rows update by their real Penta `id`; new rows insert with the CSV's own Customer ID as `external_id`), job upsert against the dedup key (same client+date+start-time updates in place — Job Total/status/etc. change; a different start time is a genuine second visit, inserted separately, never merged), an untouched-clients sweep (anyone in the business not covered by *this run's* client list gets `not_in_maids_import` added to `review_flags`; anyone who *is* covered gets it cleared), and a full derived-stat recompute (`estimated_minutes` from the trailing-12-month completed-job median actual minutes, falling back to quoted; `current_price` from the most recent job; `first_service_date`/`last_service_date`/`next_service_date`; cancellation/completion counts; per-team performance ratios) — scoped to every client with any job on file, not just this run's rows, so a jobs-only re-import still keeps stats current. Verified end-to-end with rolled-back transactions: create, re-import-updates-in-place (not duplicate), multi-visit flagging, derived-stat math, the untouched-client sweep, wipe mode, and cross-tenant rejection (a Manna user passing a different business_id is refused by the RPC's own authorization check, independent of RLS).

**Client matching** (per Tom's spec): exact CSV Customer ID → `clients.external_id` first — Manna's existing `external_id` values already look like Maids customer IDs, so this is the primary, highly-reliable path. Everything else falls to a combined name+address confidence score: 0.6×last-name + 0.4×first-name character similarity (edit-distance ratio, via the existing `_lev` helper), **gated by street-number agreement** — no house-number match caps the score at 50, so a perfect name match at a different address can never auto-match on name alone. ≥90% auto-matches and updates; 70–89% surfaces in the preview screen for Tom to confirm per row before commit; <70% creates a new client. Address parsing (`maidsParseAddress`) assumes Maids' "street, city, ST zip" comma-separated shape — **not verified against a real export**, flagged explicitly since no sample file was available; the preview screen's row counts are the first real signal if it needs adjusting.

**Team/status/holiday mapping**: `3 GREEN`/`1 RED`/`2 BLUE` → `M3`/`M1`/`M2`; codes already matching a Penta team pass through; anything else (`Team Unassigned`, `un`, blank, typos) leaves `team` null and stores the original text on `team_code_raw`, surfaced via a new "⚠️ Unassigned Team" button in the Calendar day view. Job Status maps `Scheduled`/`Cancelled`/`Complete(d)` to the exact three values the `jobs.status` CHECK constraint allows; anything else defaults to `scheduled` with a preview warning rather than failing the row. A cancelled job's `cancellation_type` is computed once, client-side, from a from-scratch US-holiday calendar (New Year's, July 4th, the 4th-Thursday-of-November Thanksgiving pair, Christmas Eve/Day, computed algebraically for any year) — company-closure cancellations are excluded from `historical_cancellation_count` and therefore never penalize client health scoring.

**sqft/room enrichment** deliberately does **not** reuse the Claire `compute_quote` tool's full cascade (see the PR #78 diagnosis: two separate, drifted MassGIS-lookup implementations already existed, neither returns bedroom count, and `compute_quote`'s book-average/state-median fallbacks synthesize a *plausible* number for a one-time quote — appropriate there, wrong to silently write into a permanent client record as if it were real). The importer's own `maidsLookupSqft` only writes a value on an actual MassGIS parcel hit; everything else is left null and flagged `needs_address_details` for manual entry. Runs as a capped (100/run), paced (300ms apart) background pass after the import summary shows — never blocks "Done" — covering both newly-created clients and any pre-existing client missing sqft, since both cases resolve to the same "sqft IS NULL" scan.

**UI additions**: Clients view gained four new filter chips (Import Review, OMS, Needs Address Details, Double-Billed — the last computed from a `jobs[]` scan cached against array length, not re-scanned per keystroke) alongside the pre-existing Active/Paused/Inactive/All status segment, which already covered "Past Client (Inactive)" with no changes needed. The client card gained a new, separate "Service History" section (distinct from the existing "Past Cleans" summary) — a sortable table (click any header, `_svcHistorySortBy`) over every job on file with quoted/actual minutes, in/out times, price, status, and cancellation reason, plus a median actual/quoted ratio header.

---

## 8ab. Maids importer header-parsing bug — Tom's real files exposed it on first upload

PR #78's preview screen collapsed 14,227 real rows into "1 unique client," every Job Status warned `"Unrecognized Job Status 'undefined'"`, and 0 rows auto-matched. Root cause, confirmed by running the real (unmodified) `maidsParseCSV`/`maidsMapStatus`/`maidsParseName` against Tom's actual export files: every Maids `Export_Job_List` CSV prepends a **variable-length preamble** — a bare `Export Job List` title line and a date-range line — before the real header row, and `maidsParseCSV` unconditionally trusted row 0 as the header. It was reading the title line as the header (one non-empty cell, everything else empty), so `row['customer name']`, `row['job status']`, etc. were `undefined` for literally every row — `String(undefined)` concatenated into the warning text explains the exact `'undefined'` string Tom saw, and every row's name+address collapsing to the same empty strings explains the single merged client group.

Two more things surfaced testing against the real files, not previously known:
- Tom's exports exist in **two different shapes** — some pad the preamble rows with trailing commas and have a 13-column header (missing Category/Package/Job Summary/Job Reference), others use bare single-value preamble lines with the full 17-column header. Both needed to parse correctly.
- **`Closed` is Maids' own term for a finished job** (confirmed against real rows: `actual_minutes`/price populated identically to `Completed` rows) and was the single most common status value in one real file — ~2,900 of ~6,400 rows, more than `Scheduled`, `Cancelled`, and `Completed` combined. It was completely unmapped before this fix and would have silently defaulted thousands of real completed jobs to `scheduled`.

**Fix — header normalization, not line-counting.** Rather than hardcoding "skip N preamble lines" (fragile against Maids changing the preamble's length or content), both the CSV's header cells and this importer's own expected column names are normalized identically — lowercased, every non-alphanumeric character stripped (`maidsNormalizeHeaderKey`) — so `"Customer Name / Company Name"` and a hypothetical `"customer_name_company_name"` both collapse to `customernamecompanyname` regardless of exact spacing or punctuation. The real header row is *found*, not assumed: `maidsParseCSV` scans the first 10 rows for the one containing a normalized `customerid` cell (the one column guaranteed present, non-blank, and unique to a real header in every shape seen), discards everything before it, and throws a clear error if no such row exists rather than silently misparsing. Every `MAIDS_REQUIRED_COLUMNS` entry not found in the detected header produces a warning naming both the raw expected label and its normalized form — the next Maids format change (a renamed or reordered column) surfaces immediately in the preview instead of reproducing this exact bug silently.

**Also added, per spec**: rows with an empty `Date` (OMS listings not yet scheduled) are skipped entirely rather than becoming garbage jobs, with an aggregate warning ("Skipped N rows with empty dates"); a trailing totals/summary row (no Customer ID, and either the word "total" appears somewhere in the row or both name and date are blank) is detected and skipped the same way, checked *before* the empty-date test so a summary row isn't miscounted as an OMS no-date row. `maidsBuildPreview`'s `rowsParsed` stat now reports the *total* rows read across all uploaded CSVs (matching what Tom already confirmed was correct), independent of how many were subsequently skipped as summary/empty-date rows — the skip counts are reported separately.

Verified against Tom's actual files (not synthetic samples): the 13-column-header 2026 file — 6,404 real data rows, 0 header warnings, 376 unique clients, 6,403 jobs (1 summary row skipped), 129 real warnings (unmapped team codes `4 YELLOW`/`5 PINK` not in `MAIDS_TEAM_MAP`, genuinely worth Tom's review, not a parsing artifact). The 17-column-header OMS file — 420 rows, 0 header warnings, 269 unique clients, 342 jobs (1 summary row + 77 empty-date rows correctly skipped), math reconciling exactly (420 − 1 − 77 = 342).

---

## 8ac. Maids importer "Option D" — same-time multi-visit duplicates (PR #80, migration 088)

Tom's first real commit attempt (all 3 CSVs, ~14,064 jobs) failed on `jobs_dedup_key` — the partial unique index on `(business_id, client_id, date, scheduled_start_time)` from migration 087. Diagnosis against the real data found exactly **7 groups** where 2 rows share all three key values. Tom's initial read was "data-entry duplicates, drop the redundant one"; after seeing the specific cases he corrected this — these are legitimate separate billing lines (main house + in-law/pool/guest house cleaned by the same team at the same nominal start time), real revenue, never to be skipped or merged, even for the 2 groups where every other field also happens to match exactly.

**Fix**: rather than changing the dedup key or dropping rows, `maidsBuildPreview` now detects any group of jobs sharing `(client_external_id, date, start_time)` and offsets every member after the first by 1 more minute (2nd = +1, 3rd = +2, …) *before* the payload is ever built — by the time `import_maids_data` sees it, every job already has a unique key. Group members are sorted by the CSV's **Job Reference** column when present (17-column file shape only) rather than file/row order, so a re-import — even one where Maids happens to emit the same rows in a different order — bumps the *same* underlying job by the *same* amount and correctly updates the existing Penta row instead of drifting or creating a duplicate. Job Reference is read for this internal tie-break only, never displayed — same "reference only" treatment Customer ID already gets. Files without a Job Reference column (13-column shape) degrade to stable original-encounter order; for the rare case of two truly byte-identical rows this is harmless since nothing user-visible differs between them regardless of which one is treated as "first."

This composes with the pre-existing multi-visit flag for free: `is_multi_visit_day` is computed by the *same* "2+ distinct start times for this client+date" check as before, which now runs *after* the offset pass — same-time collisions, once bumped, are already-distinct times by the time that check runs, so no separate flagging path was needed for them.

**Schema (migration 088)**: `jobs` gains `scheduled_start_time_adjusted boolean` (true when this row's time was bumped) and `scheduled_start_time_original time` (the raw pre-bump value — set on *every* member of a duplicate group, including the one that kept its original time, for audit symmetry). New `maids_import_duplicates` table logs one row per group member (`kept_original_time`, `adjustment_minutes`, both start times, linked to the actual `jobs.id` and `import_runs.id`) — its `import_run_id` FK is `DEFERRABLE INITIALLY DEFERRED` because the RPC reserves `v_run_id` up front and writes these tracking rows *before* the `import_runs` row itself exists (that insert happens last, after derived-stat recompute); an immediate FK check would fail every single import. Caught live: the first rolled-back-transaction test against real data failed on exactly this FK before the fix.

`import_maids_data`'s signature is unchanged — the new fields ride inside the existing `p_jobs` jsonb. It persists the two new job columns via the existing upsert CTEs, then does a second pass matching `p_jobs` rows flagged `duplicate_group: true` back to their just-upserted `jobs.id` by natural key (not threaded through `RETURNING`, since `duplicate_group`/`adjustment_minutes` aren't persisted job columns) to write `maids_import_duplicates`. The returned summary jsonb gained `duplicates_detected` (count) and `duplicates` (full case list) for the import summary screen's new "N same-time multi-visits detected. Both jobs kept, start times slightly offset. Review here" banner.

Verified end-to-end against Tom's real 3-file dataset: all 7 real duplicate groups (14 jobs) resolve with zero remaining `(client, date, start_time)` collisions client-side, and all 14 committed successfully through the live RPC in a rolled-back transaction — including a same-payload re-import check confirming it updates the same 2 existing jobs rather than creating new ones.

---

## 8ad. Maids importer batching — the ~14,000-job single-transaction commit was blowing an 8s role-level statement_timeout (PR #81, migration 089)

Tom's first full-data commit attempt (all 3 CSVs) failed with `canceling statement due to statement timeout`. He assumed Postgres's ~60s generic default; the actual figure, confirmed live via `pg_roles.rolconfig`, is `authenticated` role → `statement_timeout=8s` (`anon` → 3s; `service_role` → none). `import_maids_data` did client upsert + full job upsert + derived-stat recompute + review-flag sweep in one statement. None of those pieces is individually slow — benchmarked at full scale (14,000 synthetic jobs, run under `SET ROLE authenticated` so RLS is actually enforced, not bypassed the way a superuser admin connection would): the job upsert CTE chain (trigger + RLS included) took ~4.3s, the derived-stat recompute ~0.8s. Summed into one statement, comfortably over 8s; apart, nowhere close. Not an ORM per-row problem (the job upsert was already set-based `INSERT...SELECT`, no loop) and not a bad query plan — one oversized statement against a hard per-role cap.

**Fix**: split into three RPCs, orchestrated client-side in sequence, each its own transaction:
1. **`import_maids_start`** — wipe (if the danger-zone toggle is on) + client upsert (~900 rows) + the untouched-clients review-flag sweep (moved here from the old single RPC — it only ever depended on the client lists, not on jobs) + a provisional `import_runs` row so every later call can reference the same `run_id`.
2. **`import_maids_jobs_batch`** — job upsert for one batch. JS (`maidsChunkArray`) splits `p_jobs` into 500-row slices; measured live at ~150-800ms per batch even at the full 14,000-job scale. Idempotent by construction (upsert on the existing `(client, date, scheduled_start_time)` dedup key from migration 087) — resending an already-succeeded batch on retry just re-writes the same values, no special-casing needed.
3. **`import_maids_finish`** — derived-stat recompute (once, not per batch — the old RPC only ever paid for this once too, so batching doesn't add cost, just moves it to its own call) + writes the run's final totals (accumulated client-side across every batch response) + returns the summary jsonb the import screen renders, including the aggregated `duplicates`/`duplicates_detected` from every batch's `maids_import_duplicates` rows.

`import_maids_data` is dropped — nothing calls it after this ships, and an RPC that reliably times out on real data isn't worth leaving around.

**Client-side orchestration** (`maidsRunCommitBatched`) drives the three calls and renders "Importing batch N of M…" with a fill bar between batches (`renderMaidsImportProgress`). Resume state lives on `_maidsState.commit` (`runId`, the chunked `batches`, `nextBatchIndex`, accumulated counts): a batch failure leaves `nextBatchIndex` at the failed batch and shows a Retry button (`renderMaidsImportError`) instead of an alert; retrying re-invokes the same orchestrator, which sees the existing `_maidsState.commit`, skips `import_maids_start` entirely (the run already exists), and resumes the loop from the failed batch — already-committed batches are never re-sent, though resending one would be harmless anyway given point 2 above.

**Caught live**: the first rolled-back-transaction test of the new flow returned `run_id: null` from `import_maids_finish` — its `UPDATE public.import_runs` silently matched zero rows. Migration 087 had only ever added `SELECT`/`INSERT` RLS policies to `import_runs`, no `UPDATE` policy; under RLS (enforced for the real `authenticated` role, not the bypassing superuser connection used for earlier ad hoc queries), an `UPDATE` with no permissive policy matches nothing and raises no error — it just silently updates zero rows. Fixed by adding `import_runs_update` (same owner/admin/manager gate as the other two). A reminder that "no policy for this command" fails silent-empty, not loud, for UPDATE just as much as it does for SELECT.

Verified end-to-end: a full 29-batch simulation (14,500 synthetic jobs across 892 clients, run as `authenticated` with RLS live) completed with every individual call comfortably under 8s (client upsert ~0.7-1.3s, batches 180ms-820ms, finish ~1.7-2.1s) and correct final totals; the real 7-duplicate-group/14-job dataset from PR #80 was re-run through the new start/batch/finish flow (across 2 batches) and produced identical duplicate-tracking output to the old single-RPC flow.

---

## 8ae. Post-import date drift — `new Date('YYYY-MM-DD')` on job dates rolls back a day in EDT (PR #82)

Post-import, Lisa Creighton's real 7/7 clean showed as 7/6 in the Client History "Jobs" tab, and its GPS-match detail reported "No GPS records matched this clean" even though real Geotab trip data existed for that day. `jobs.date` in the DB was confirmed correct (`2026-07-07`, a plain `date` column — no timezone component to drift at storage). The bug is entirely client-side: `new Date('2026-07-07')` (no time component) parses as **UTC midnight**, which in any timezone behind UTC (Manna's business TZ, America/New_York, is UTC-4/UTC-5) is still the previous calendar day locally — every subsequent local-time read (`.toLocaleDateString()`, `.setHours(0,0,0,0)`, a `<`/`>` comparison against a local `Date`) inherits that already-wrong day.

Two independent sites had this pattern (a third, unrelated Live Tracking bug was also found and is tracked separately, not fixed here — see below):
- **`renderHistoryJobsTab`** (`index.html`, Client History → Jobs tab): the past-jobs filter, the sort, and the display-string formatter all built `new Date(j.date)` directly.
- **`fetchTeamDayStops`** (feeds `getJobHistoryMetrics`/`toggleJobHistRow`'s GPS-match detail, and `_resolveTeamDevice`'s team-device lookup): built its Geotab `Trip` search window (`fromDate`/`toDate`) and device-resolution date key from `new Date(dateStr)` on the raw job date — silently querying Geotab for the *previous* day's trips, which explains the false "no GPS record" report (the message was accurate for the date actually being queried; the date being queried was wrong).

Both fixed the same way: anchor the string to local midnight before constructing the `Date` — `new Date(dateStr + 'T00:00:00')` — rather than switching to manual string-splitting (the pattern several *other* date-display helpers in this codebase already use safely: `_isoToMDY`, `_svcHistoryFmtDate`, `_gccFmt`, `_audFmtDateShort` — all pure string-split, all unaffected by this bug; `PentaJobs._transformRow` also passes `date` straight through as a string with no conversion, so the DB-read layer was never the problem). This is a "mirrored implementation diverged" bug: 5+ independent date-formatting call sites exist in this file, and 2 of them never got the `T00:00:00` anchor the other safe ones already use.

**Verified**: reproduced the exact rollback in Node under `TZ=America/New_York` (old code: `new Date('2026-07-07')` → "Mon, Jul 6, 2026"; fixed code → "Tue, Jul 7, 2026"; the Geotab trip-search window shifted by the same 24h). Spot-checked 5 additional real clients' completed-job dates against the fixed formatter — all render on their correct DB date.

**Not fixed here, flagged as a separate follow-up**: `renderGPS()` (the main Live Tracking view) hardcodes `dateKey(new Date())` — i.e. "today" — when building the job list used to match GPS stops to the schedule and render the `UNSCHEDULED` badge / job-count badge, regardless of what day is selected on the `#gps-date-picker`. This is a different bug class (a missing date-scope thread-through, not a UTC-rollback), doesn't reproduce Tom's reported symptom (which was specifically the display/GPS-match date being off by one day, both explained by the two fixes above), and touches Live Tracking's core stop-matching logic — scoping it into a dedicated PR rather than bundling it into this timezone fix.

---

## 8af. Revenue clock showing $0 for days with real completed-job revenue (PR #83)

Tom's revenue clock (top-of-screen daily total) showed $0 for August 3rd despite the schedule showing 19 completed cleans that day. DB check: `jobs.status = 'completed'` for all 19, summing `price` to $5,303.36 — the status field was never the problem (the Maids importer's `Closed` → `completed` mapping from PR #79 worked correctly). The bug was entirely in the JS rollup's filter.

`getDayRevenue(dateStr)` filtered `jobs` on `j.date === dateStr && !j.done && !j.autoGenerated && !j.cancelled` — the `!j.done` condition **excluded** every completed job from the day's revenue set. `PentaJobs._transformRow` derives `done: row.status === 'completed'` (and the inverse write path treats `j.done` as meaning `status = 'completed'` too), so `!j.done` literally meant "only count jobs that are NOT completed." This bug is old, not introduced by the importer — but it was invisible before because almost no job in this tenant was ever marked `completed` prior to the Maids import (see [[project_job_status_never_transitions]]/PR #48: 1916 of 1927 pre-import jobs still read `scheduled`). Once the import brought in thousands of real `completed` historical and current jobs, every day with actual completed revenue started rendering $0.

**Fix**: flip `!j.done` → `j.done` — revenue counts completed jobs only, per Tom's stated intent ("Revenue should equal sum of job_total for completed jobs"), still excluding cancelled and auto-generated-projection rows and still excluding paused/inactive clients (unchanged from before). `_teamDayStats` (the Team Assignments header row's per-team daily stats) carries an explicitly-documented "same filter rules as getDayRevenue" copy of the identical bug — fixed identically.

**Left alone, intentionally**: two independent Claire chat-tool revenue implementations (`revenue_summary`, `team_performance`) never had a `done` filter at all — they already correctly counted completed jobs (plus scheduled ones, for a "this week's revenue outlook" framing) and would have answered Tom's original question correctly if asked via chat instead of read from the header. Not touched here since Tom's report was specifically about the top-of-screen clock and these tools weren't reported broken; aligning their semantics (scheduled+completed vs. completed-only) is a product decision, not a bug fix, and is flagged here rather than silently changed.

Verified: DB shows $5,303.36 across 19 completed jobs for 2026-08-03, all `active`-status clients, none `auto_generated` — the fixed filter now includes exactly this set, confirmed by summing the real per-job prices.

---

## 8ag. Clients tab: Recurring/OMS/Inactive segment (PR #84)

Post-import, the Clients tab mixed ~433 one-time OMS clients and ~331 inactive clients in with the ~460 normal recurring ones, all under one list with no way to separate them. Added a new primary segment (`#client-type-segment`, `renderClientTypeSegment`/`setClientTypeFilter`/`clientTypeFilter`) above the existing Active/Paused/Inactive/All status segment from migration 008: **Recurring** (default) / **OMS** / **Inactive**.

**Recurring is `!tags.includes('oms_only')`, not `tags.includes('recurring')`.** A manually-created client (`+ New Client`) never gets a `recurring` tag — only the Maids importer sets it, and only on clients with a 2026 recurring-schedule row (`clients.tags` defaults to `'{}'`). Requiring the positive tag would have made every non-imported client invisible in the default view. The negative check (everyone *except* OMS-only clients) is safe for both imported and manually-created clients and matches Tom's intent ("Recurring active clients only" as the default, meaning "not the one-time OMS bucket").

**OMS and Inactive bypass the nested Active/Paused/Inactive/All status segment** (hidden via `renderClientTypeSegment` when either is selected) — active/paused doesn't meaningfully apply to a one-time OMS booking, and "Inactive" here already fully determines its own slice (`status === 'inactive'`, independent of tags) rather than nesting under another status control. Within the Recurring tab, the existing status segment still works exactly as before (Active is the default, Paused/All still selectable) — this composes as "default = Recurring tab + Active status," matching Tom's literal spec, while keeping the pre-existing Paused-status workflow intact rather than replacing it.

The redundant `oms_only` quick-filter chip (added in PR #78, in the secondary filter-chips drawer) was removed now that OMS is a primary tab — having both would let a manager accidentally AND them together with no visual explanation for why the list went empty.

Verified against real data: `!oms_only` (Recurring) = 460 clients, `oms_only` (OMS) = 433, `status='inactive'` (Inactive) = 331 (460 + 433 = 893 = total, confirming the importer's tag logic keeps `recurring`/`oms_only` mutually exclusive as designed); default view (Recurring + Active) = 374 clients.

---

## 8ah. Backfill: 22 stale `scheduled` jobs past their date (PR #85, migration 090)

Follow-up to PR #83 (revenue clock now correctly counts only `status='completed'` jobs) — 22 real jobs for Manna were still stuck at `status='scheduled'` despite their date already being in the past (earliest 2025-01-10, latest 2026-08-03, including the exact Jane Mahle job flagged in the PR #83 diagnosis, $317). These reflect the Maids export's status *at export time* — the export ran before some scheduled cleans had happened yet, and nothing in this app auto-transitions a job's status as its date passes.

**One-time data backfill, not a new ongoing rule**: `UPDATE jobs SET status='completed' WHERE business_id=<manna> AND status='scheduled' AND date < CURRENT_DATE`. Deliberately does not touch today/future `scheduled` jobs or any `cancelled` job, and does not add an auto-completion trigger — a job whose date passes still requires an explicit status change going forward. (PR #86's realized-vs-projected revenue split handles today/future differently at the *display* layer instead, without ever mutating `status` automatically — see below.)

Verified: 0 jobs remain `scheduled` with a past date for Manna post-backfill; 2026-08-03 now sums to exactly $5,620.36 across 20 completed jobs, matching Tom's real recorded revenue for that day almost exactly (the $0.36 gap is rounding in Tom's own manual total).

---

## 8ai. Realized (past) vs projected (today/future) revenue (PR #86, migration 091)

PR #83 made every revenue display require `status='completed'`, correct for past dates but wrong for today/future — a day where nothing has been marked done yet showed **$0** even with a full board of scheduled work. Confirmed live: 2026-08-05 (today, at diagnosis time) had 22 scheduled jobs worth $6,003 and zero completed — the revenue clock was showing $0 for it pre-fix.

**Diagnosis**: there was no existing past-vs-today branching anywhere — one function, `getDayRevenue(dateStr)`, ran the identical `status='completed'`-only filter for every date. Every revenue-showing surface traces back to it or a documented mirror: `#cal-day-rev` (the top-of-Calendar clock, day/week/month modes via `updateRevDisplay`/`getWeekRevenue`/`getMonthRevenue`), the 365-day week-strip's per-day `$` chips (a `getDayRevenue()` call per day, spanning roughly 180 days back to 185 days forward — this is the "day-view revenue chip"), and `_teamDayStats` (Team Assignments header row, explicitly documented as mirroring `getDayRevenue`'s filter). Two independent Claire chat tools, `revenue_summary` and `team_performance`, had NO `done` filter at all — they already counted scheduled+completed together for an entire period including past days, inconsistent with the dashboard in the other direction.

**Fix**: since `jobs.status` only ever has three values (`scheduled`/`completed`/`cancelled` — no `in_progress`), "scheduled + in-progress" from Tom's spec collapses to simply "not cancelled." Each function now branches on whether the job's own date is before today (computed via `dateKey(new Date())`, a plain string comparison against `dateStr` — no `new Date(dateStr)` parsing of the job's own date anywhere in this change):
- **Past**: unchanged from PR #83 — realized revenue, `done` required.
- **Today/future**: projected revenue — the `done` requirement is dropped; cancelled and auto-generated-projection jobs are still excluded, so every live-scheduled job counts and the total updates live as jobs complete or get cancelled during the day.

`getDayRevenue` and `_teamDayStats` gained one added condition each; `revenue_summary` and `team_performance` gained the equivalent per-job check (using each job's own date against the query range's "today," so a range straddling today like "this_week" correctly applies realized rules to its past days and projected rules to the rest) — bringing all four into agreement for the first time.

**GPS cross-check — explicitly out of scope for this PR.** Tom's full spec includes flagging completed jobs with no matching `gps_match_log` record, gated by a per-business cutover date ("Tom wasn't using Penta operationally before, so no reliable GPS-to-job attribution exists for pre-cutover jobs"). `gps_match_log` and the `resolve_job_from_gps_stop` RPC already exist and are exactly what that check would reuse — but the check itself (an end-of-day run, and an "Open Items" surface that doesn't exist yet anywhere in this app) is real, separate future work, not built here. This PR ships only the schema scaffolding: `businesses.gps_verification_start_date date` (migration 091, nullable, NULL = not set) plus a minimal Admin → "GPS Verification" date field to set it. Setting the date does not activate anything yet — it's storage only, explicitly labeled as such in the admin UI copy, until the cross-check job is actually built.

Verified: 8 new Node assertions (extraction-based against the real `getDayRevenue`/`_teamDayStats` source, dates computed relative to the real system clock so the test never goes stale) covering past/today/future/autoGenerated-exclusion for both functions.

---

## 8aj. Clients tab: Active badge counted the whole business, not the Recurring tab (PR #87)

Tom reported the Recurring tab showing "Active (562)" when the real active-recurring count is ~374. Diagnosis: the actual card list (`applyFilters`'s predicate) was already correctly excluding `oms_only` clients on the Recurring tab — verified directly by reading the filter code, not just its output. The bug was isolated to `renderClientStatusSegment()` (the Active/Paused/Inactive/All badges from migration 008, PR #84): its counts iterated `PentaClients.list()` — all 893 clients — instead of the same Recurring-tab-scoped set the list beneath it uses. 562 is exactly the active-client count across the *entire* business (verified via SQL); this segment is only ever shown while `clientTypeFilter === 'recurring'` (`renderClientTypeSegment` hides it for OMS/Inactive), so its badge should have matched that scope from the start.

Also checked and ruled out per Tom's alternate hypotheses: no client has both `oms_only` and `recurring` tags (mutually exclusive by the importer's own tagging logic, confirmed live: 460 recurring + 433 OMS = 893 = total); every `oms_only` client has `frequency='OMS'` cleanly, no accidental recurring-frequency mapping from import.

**Fix**: `renderClientStatusSegment()` now skips `oms_only`-tagged clients when tallying, matching the Recurring tab's own filter. Verified against real data: Active 374 / Inactive 86 / Paused 0 / All 460 (this tenant has zero paused clients).

---

## 8ak. Client cancellation flow (PR #88, migration 092)

New "🚫 Cancel Client" button on active client cards (client-list action row, next to Activity/Edit — hidden once a client is already paused/inactive). Two-step modal: preset reason (9 options, required) + free-text notes (optional), then — only if the client has future scheduled jobs — a second step ("This client has N future jobs. Cancel all? [Yes] [Review each]", Tom's Option C) before committing.

**Diagnosis first**: `clients.status` is a 3-value Postgres enum (`active`/`paused`/`inactive`), no CHECK beyond the enum. The only existing path to `inactive` was manual, via the Edit Client modal's status dropdown — a plain field write with no cascade, no reason capture, and no semantic audit action (fell into `audit_clients_capture`'s generic `'updated'` bucket). `jobsForDate`/`getDayRevenue` already exclude any job belonging to a paused/inactive client, so flipping status alone already hides a cancelled client's future jobs from the schedule and projected revenue *immediately* — the future-jobs question is about DB hygiene/audit correctness, not an immediate visual bug either way. Inactive clients stay fully in the dataset (a separate `deleted_at` soft-delete already exists, untouched by status) and are already reachable via the Inactive tab (PR #84) for churn/marketing purposes, satisfying "should cancelled clients still appear in historical views."

**Schema**: `clients.cancellation_reason` (CHECK'd against the 9 preset values), `cancellation_notes`, `cancelled_at`, `cancelled_by` (→ `users.id`). `audit_log_capture()` gained a `clients` branch mirroring the one `jobs` already has: `cancelled_at` going NULL→non-NULL auto-labels the audit row `action_type='cancelled'` — no separate manual `audit_log` insert needed, since the trigger's existing full-row `to_jsonb(NEW)` snapshot already carries the reason/notes.

**Two facade write-mapping gaps found and fixed while building this** (same bug class as [[feedback-read-priority-field-not-updated-by-write]] — a write path silently missing a field the read path already knows about): `PentaClients._transformRowForWrite` had no mapping for the four new columns at all — `updateClient()`'s optimistic local-cache merge (`Object.assign`) would have made the UI *look* like it worked while the DB write silently dropped every one of them. `PentaJobs._transformRowForWrite` was separately missing `cancellationType` → `cancellation_type` (the read side, `_transformRow`, already mapped it) — needed for auto-cancelling a client's future jobs with `cancellation_type='client_initiated'`. Both fixed by extending the existing mapping functions, not by adding a new write path.

**Future-jobs cascade** ("Yes, cancel all"): dual-write, matching `saveClientEdit`'s existing team-cascade pattern exactly — mutate the global `jobs[]` array directly + `saveJobs()` (every schedule/revenue read path reads `jobs[]` synchronously) first, then fire `PentaJobs.update()` per job async to persist to Supabase and keep `PentaJobs`' own cache in sync. "Future" = `date >= today` (today counts — hasn't happened yet), excludes already-done/cancelled jobs and auto-generated projections (which stop projecting forward the moment `buildSchedule` sees the client's `paused`/`inactive` status, so there's nothing to explicitly cancel there).

No new RPC — `clients_update`/`jobs_update` RLS (`auth_belongs_to_business`, no extra role check beyond `jobs_update`'s existing owner/admin/manager/dispatcher gate) already permit these writes via the same plain `PentaClients.updateClient()`/`PentaJobs.update()` paths every other client/job field edit already uses.

Verified: 5 new Node assertions (extraction-based, dates relative to the real system clock) for the future-jobs filter and the reason-list/CHECK-constraint match; a full rolled-back live-transaction test (client cancel + cascade job cancel against a real client with 22 future jobs) confirmed the client row, the cascaded job cancellations, and the auto-labeled `action_type='cancelled'` audit_log row all land correctly; confirmed the CHECK constraint rejects an invalid reason string.

---

## 8al. Team Assignments UI cleanup (PR #89)

Pure visual/layout polish, no data or logic changes — four items on `renderTeamManager` (Team Assignments modal):

1. **Removed the "History" button** and its handler `toggleTeamDeviceHistory` (queried `team_device_assignments` for the last 5 rows into a collapsible `#tda-history-${team}` div). Confirmed via grep it was called from exactly one place before removal — safe to delete both together.
2. **Collapsed the GPS vehicle selector** from a separate full-width row (a "Currently: ..." text line + a `🚗 GPS Vehicle:` label + a full-width `<select>` + an "effective until" date input + the History button) into a compact `🚗 <car> ▾` chip inline in the team header, alongside team name/employee count/revenue/houses/hours. The underlying `<select id="tda-select-${team}">` is **functionally unchanged** — same `onchange="setTeamDeviceAssignment(...)"`, same options, same save path (`team_device_assignments` upsert) — it's visually collapsed to `opacity:0` and layered via `position:absolute` over the visible chip text, so a tap on the chip/arrow lands directly on the native select and opens its picker exactly as before. The "effective until" date input (`#tda-until-${team}`) survives too, restyled compact and label-less, moved into the same header row.
3. **Removed the "Currently: ..." text line** — was the redundant restatement directly above the old verbose row, gone along with the row itself.
4. **Removed the duplicate date** — `#team-mgr-date-label` (a formatted-text restatement of the date, e.g. "Monday, August 5") sitting directly under the "👥 Team Assignments" heading, redundant with the actual `<input type="date" id="team-mgr-date">` picker right next to it in the same header row. The picker (the only one that actually changes the day) is untouched.

Verified: `node --check` on the extracted inline script; grepped for every removed id/function (`team-mgr-date-label`, `toggleTeamDeviceHistory`, `tda-history-`) post-edit to confirm zero remaining references; confirmed `#tda-select-${team}`/`#tda-until-${team}` — the two ids `setTeamDeviceAssignment` actually reads on save — are unchanged in both id and save-path wiring.

---

## 8am. Team Color (PR #90, migration 093)

`teams.color` already existed (added at some earlier point, per the column list — nullable, no default, no format check) but had no editable UI beyond the optional param on `PentaTeams.create()`, and no write method existed for an *existing* team (`rename()` only touched `name`). New "Team Color" field in the Staff → Teams → click-team modal (`openStaffTeamDetailModal`), the one place that already shows employees + GPS vehicle for a team — 10 preset swatches (Red/Orange/Amber/Green/Teal/Cyan/Blue/Indigo/Purple/Pink) + a native `<input type="color">` "Custom" swatch, selected one gets a ring + checkmark.

**Schema**: `ALTER COLUMN color SET DEFAULT '#3B82F6'`, a `teams_color_format_check` CHECK (`^#[0-9A-Fa-f]{6}$`, nullable still allowed), and a sequential-preset backfill for any row still missing a color (`ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY display_order, created_at)`, wrapping `% 10`) — a no-op for Manna today (all 8 active teams already had real colors from the legacy hardcoded map) but real protection for any other tenant/future team. `teams` also gained its first-ever audit trigger (`audit_teams_capture` + a `'teams' → 'team'` case in `audit_log_capture()`'s entity-type mapping) — no team change of any kind was audited before this.

**`PentaTeams.updateColor(teamId, color)`** — new facade method, same plain-write pattern as the existing `rename()` (no RPC needed; `teams_update` RLS already permits it). The edit modal itself is keyed by legacy team-code *string* (`"M3"`), not the PentaTeams row *id* color lives on — resolved via `PentaTeams.getByName(team)`, the exact same name lookup `_pentaTeamColor()` already relies on everywhere else, confirmed to resolve correctly for all 8 of Manna's active legacy codes.

**Why the other 5 "where color should appear" surfaces needed zero code changes**: this codebase already went through a "Sprint 7: PentaTeams-first team list + color resolvers — single source of truth" pass before this feature. Every surface Tom listed (Team Assignments header, schedule-board job dot, Live Tracking row, the per-employee team-assignment picker, the Staff→Teams list) already resolves color via `_pentaTeamColor()` or a direct `PentaTeams.getById()/getByName()` lookup, live off the same `teams.color` this feature writes to — so once a real write path existed, they all picked it up automatically. Verified this by reading every one of the ~30 call sites, not by assuming the "single source of truth" comment was still accurate: found and confirmed 8 *additional* sites (an Employee Portal preview badge, the real-employee login badge, the portal's own schedule accent, the Staff panel's two employee-list renderers, the employee profile page, and the client-edit "Assign Team" picker) that also **already** check `PentaTeams.getById`/`getByName` first and only fall back to an old hardcoded map (`TEAM_COLORS`/`COLORS`, both stale duplicates of the same values) when an employee has no `team_id` set (2 of 19 active Manna employees, a pre-existing data-completeness gap unrelated to this feature, not fixed here) — none of these needed editing either.

**Accessibility**: color is additive everywhere it appears — the team code/name is already rendered alongside every color dot/accent across all these surfaces (pre-existing, not something this feature had to add), so nothing here makes color the sole differentiator.

Verified: 9 new Node assertions (extraction-based) for the swatch picker — exact palette match, single-checkmark-on-selected-preset, custom-color path, case-insensitive hex matching. Live rolled-back-transaction tests: a color update correctly auto-audits (`action_type='updated', entity_type='team'`, old/new color both captured); the CHECK constraint rejects a non-hex string; a synthetic second-tenant team row (real `businesses` row, "Test Business Two") confirmed Manna's own owner cannot write to another tenant's team color — RLS silently no-ops the UPDATE (0 rows affected) rather than erroring, same pattern as every other cross-tenant boundary already verified this session.

---

## 8an. Cancelled jobs still plotting as stops on the Schedule Map (PR #91)

Three independent "plot today's jobs" filters existed across the file, and only one of them excluded `status='cancelled'` jobs. Confirmed live: Manna had 3 real cancelled jobs on 2026-08-05 alone that were rendering as phantom pins/route stops.

**Bugs found and fixed** (each a one-line filter addition — `!j.cancelled`, which is type-agnostic by construction, so it excludes `cancellation_type='client_initiated'` and `'company_closure'` identically without needing to check the type at all):
- `_scheduleMapDayJobs()` (`index.html`) — the single shared data source for **both** the inline Schedule Map (under the day's job list on the Calendar tab) and the fullscreen Schedule Map modal (`openScheduleMap()`). One fix covers both surfaces, confirmed by grepping every call site.
- `buildRoutes()` — the Route Optimizer's day-job list, a second independent "plot the day's stops and build a driving route" feature. Same missing-exclusion bug, same fix.
- `renderGPS()`'s `teamJobs` — Live Tracking's cross-reference of GPS stops against the day's schedule (drives the `UNSCHEDULED` badge via `matchStopToClientGeo` and the completed-job count). A cancelled job here could make a coincidental GPS stop near that address silently read as "scheduled" instead of flagged.

**Verified as already correct, left untouched**: `jobsForDate()` (the main Calendar/Schedule board's list view) deliberately does *not* exclude cancelled jobs — it shows them with a red `CANCELLED` badge, and separately computes house/hour stats via its own `!j.cancelled` filter (`renderCal`'s `liveJobs`). `_teamDayStats()` (Team Assignments board), the employee portal's "today's jobs" count, drag/drop time recalculation, and `getDayRevenue()` all already excluded cancelled jobs correctly before this PR.

No "Dispatch" view exists in this app — every case-insensitive "dispatch" hit in the file is SMS/message dispatch, unrelated.

Verified: 2 new Node assertions (extraction-based) confirming `_scheduleMapDayJobs()` excludes both cancellation types identically alongside wrong-day/no-team/auto-generated exclusions; the other two fixes verified by direct code read (both are async/DOM-heavy functions not cleanly extractable, same one-line pattern); confirmed live that Manna currently has real cancelled jobs today that this fix now correctly excludes.

---

## 8z. Client-list "Sort:" dropdown leaking onto the Employee portal and Staff tab

Tom reported `#client-sort-row` (the Clients tab's "Sort: Last name A→Z" dropdown) rendering at the top of two surfaces it shouldn't: the Employee portal (above the "Good evening" greeting) and the manager Staff tab.

**Where it lives**: `#client-sort-row` is a DOM *sibling* of `#clients-view` (added in the client-list-sort feature, own comment: "Toggled alongside .search-wrap/.filter-row in showTab() so it only shows on the Clients tab, same as those two"), not nested inside it, and its static markup has no default `display:none`. Its visibility is therefore entirely the job of whichever "manager chrome" show/hide list happens to run — and there are **four** independent ones, not one:

1. `showTab(tab)` — generic per-tab toggle, `[topSearch, filterRow, sortRow, statsBar, installBanner].forEach(...)`. Already included it. Correct.
2. `showClientsSubview()` — restores visibility when returning to the Clients tab's own list view. Already included it. Correct.
3. `showStaffView()` — the Clients↔Staff sub-toggle's "switch to Staff" half. Its hide-list was `[searchWrap, filterRow, statsBar]` — **missing `sortRow`**. This is why it leaked onto the Staff tab: switching from Clients to Staff never touched the sort row's `display`, so whatever it was left visible.
4. `body.in-portal` CSS rule — the "hide every manager-shell element while the employee portal is open" block (`#clients-view`, `.topbar`, `.search-wrap`, `#filter-row`, etc., all `display: none !important`). **Missing `#client-sort-row`** from that selector list. This is why it leaked onto the Employee portal — nothing in that rule ever targeted it.

Both omissions are the same failure mode: when the sort dropdown was added as a new manager-chrome element, it was correctly wired into the two lists that manage the Clients↔non-Clients-tab boundary (`showTab`, `showClientsSubview`) but missed the two lists that manage *other* transitions (Clients↔Staff sub-toggle, manager↔employee-portal mode) — parallel lists that needed the same addition and didn't get it. Same class of bug as [[feedback-mirrored-algorithm-copies-diverge]], just expressed as independent show/hide selector lists instead of duplicated JS logic — a fourth instance of that pattern this session.

**Fix**: added `#client-sort-row` to `showStaffView()`'s hide-`forEach` and to the `body.in-portal` CSS selector list. Left `showTab()` and `showClientsSubview()` untouched (already correct) — verified via test that Schedule tab, which only ever went through `showTab()`'s already-correct generic toggle, was never actually affected by this bug class.

---

## 8y. Add Employee form: split Full Name into First Name / Last Name

Split the single "Full Name *" input on the Add Employee form (`#staff-modal`'s edit tab, same styling as PR #75) into "First Name *" / "Last Name *", both required, laid out in the same two-column grid pattern already used for Phone/Email below it.

**Data model — no migration needed.** `public.employees` already has `first_name text NOT NULL` and `last_name text NOT NULL` columns; there is no `full_name`/`name` column at the DB level at all (confirmed live via `information_schema.columns`). The single "Full Name" input was purely a UI simplification — `PentaEmployees._toRow` already split it via `_splitName()` (first word → `first_name`, remainder → `last_name`, defaulting to `'-'` when the typed name was a single word, since `last_name` can't be null) at save time, and `_fromRow` already recomposes `emp.name = (first_name + ' ' + last_name).trim()` at read time for every display surface. So: **display surfaces need no changes** — every existing consumer of `emp.name` (team rosters, schedule assignments, Hours Report, GPS client-name matching, etc.) keeps working unchanged, since that computed field's inputs (`first_name`/`last_name`) are exactly what the new form now sets directly instead of guessing.

**Existing employees with only a single name typed into the old field**: confirmed live, 7 of 28 active employees have `last_name = '-'` (the historical placeholder). No backfill — editing one of these now shows `-` in the new Last Name field, editable in place like any other value. Both fields are required going forward, so this placeholder can only persist until the next time that employee's profile is edited.

**Removed two duplicated "guess the split" blocks.** Beyond `_toRow`'s fallback (kept, as a safety net for any other future caller that only supplies a combined `name`), `saveStaffEmployee()` had grown two of its *own* independent copies of the identical first-space-split logic — one building the `employees` dual-write patch, one building the companion `users` row when promoting someone to manager. Both are now direct reads of `emp.first_name`/`emp.last_name` (populated straight from the new form fields), removing two more instances of the "duplicated logic silently drifts" pattern this session has hit repeatedly (see the mirrored-algorithm-copies memory) — before they had a chance to.

**Scope note**: `#main-emp-modal` (Team Manager's own parallel Add/Edit Employee modal, fixed for CSS in PR #75) still has a single "Full Name" field — left as-is here since that modal has zero live callers (confirmed dead code), and splitting its name handling too would mean writing equivalent logic for code nothing currently reaches. Worth revisiting together if that modal is ever rewired.

---

## 8x. Add Employee form inputs invisible — --surface2 was identical to --surface

Tom reported the Add Employee form (Staff → "+ Add", `#staff-modal`'s edit tab, header "Add New Employee") rendered as bare labels with no visible input boxes. First diagnosis pass (checking `openAddStaff()`'s target markup) wrongly concluded the form was already correctly styled — every input DID have the standard inline pattern (`background:var(--surface2);border:1px solid var(--border);border-radius:9px;padding:11px 14px`, label above). That conclusion was source-code-only and wrong: the STRUCTURE was right, but `--surface2` (`rgba(255,255,255,1)`, solid white) is **identical** to `--surface` (`rgba(255,255,255,1)`, also solid white — the modal sheet's own background) — both set that way by a "v9.3 hotfix" comment that made them opaque without differentiating them. `--border` (`rgba(255,255,255,0.5)`, white at 50% opacity) has no visible contrast against a white fill either. An input rendered with these three values is genuinely white-on-white — technically styled, visually invisible. This is a global `:root` token bug, not specific to the employee form.

**Why "Add Client" wasn't reported as broken too, even though it shares the identical broken tokens**: `openClientEdit`'s `.field-input` class and the generic `.form-input`/`.form-select`/`.form-textarea` classes (used by the customer-form overlay) reference the exact same `var(--surface2)`/`var(--border)` pair. The bug is almost certainly present there too — just less jarring with fewer, more spread-out fields than the employee form's dense multi-section layout, so it read as "minimalist" rather than "broken."

**Fix, scoped deliberately below `:root`'s `--surface2`/`--border` directly**: those two tokens are referenced ~930 times across the file (388 + 545) for buttons, chips, badges, and other non-input UI that can't be visually re-verified in this environment (no live browser). Blindly re-theming them site-wide risked invisible-to-me regressions elsewhere. Instead added two new tokens, `--input-bg` (`#F1F0F6`) and `--input-border` (`#DBD9E4`) — solid, unambiguous colors (no alpha blending to reason about) — and pointed every genuine form-input consumer at them: `.field-input` (Add Client's `openClientEdit`), `.form-input`/`.form-select`/`.form-textarea`/`.form-close` (the customer-form-overlay pattern), the Add Employee form (`#staff-modal`'s edit tab, ~40 inline-styled fields), and `#main-emp-modal` (Team Manager's parallel Add/Edit Employee modal — currently unreachable dead code per a confirmed zero-caller check, fixed anyway since it's free and keeps the pattern consistent for whenever it's rewired). This gives Add Employee genuine — not just nominal — visual parity with Add Client: both now render through the same corrected tokens, rather than both referencing an accidentally-identical, invisible pair. No form logic, validation, field ids, or save/populate functions were touched — confirmed via a diff review that every changed line is a `var(--surface2)`→`var(--input-bg)` / `var(--border)`→`var(--input-border)` substitution or the new `:root` declarations, nothing else.

---

## 8w. Team removal still didn't work after PR #68: team_id, not just team_text

PR #68 (§8q) fixed *who* a team write targets (the ambiguous `getByName` name-collision bug). Tom reported Remove was still broken afterward — "row flashes momentarily but nothing changes." Different mechanism, same shared write path (`_setEmployeeDefaultTeam`): the write only ever set `employees.team_text`. `PentaEmployees._fromRow` resolves an employee's displayed team from `team_id` (a Sprint 6.9 FK to the `teams` table) **first**, falling back to `team_text` only when `team_id` is null. Confirmed live: **27 of 27** active employees have `team_id` populated — they're all created/edited through the full employee-profile forms (`saveStaffEmployee`/`saveMainEmployee`), which write `team_id` and `team_text` together. So clearing `team_text` alone was a guaranteed no-op for every real employee: the write succeeds, the modal re-renders (the "flash"), and the very next read resolves the team right back from the untouched `team_id`.

Verified live with a rolled-back transaction against a real employee row: after `UPDATE employees SET team_text = ''`, `team_id` was still populated and still resolves to the original team name via the `teams` join — reproducing the exact symptom outside the app entirely.

Tom's diagnostic question — "compare to add-employee flow on the same surface, what's different about the remove path" — the honest answer is: nothing, code-wise. Both `staffTeamAddEmployee` and `staffTeamRemoveEmployee` route through the same `_setEmployeeDefaultTeam`, and both had the identical `team_id` gap. Add "worked" more often only because Tom more often exercised it through the full profile-edit form (which sets `team_id` correctly) rather than this quick in-modal path; Remove has no equivalent full-form entry point, so it exclusively hit the broken path every time.

**Fix.** `_setEmployeeDefaultTeam` now resolves the target team code (e.g. `"B1"`) to its `team_id` via `PentaTeams.getByName` and writes both fields together — a remove clears both to `''`/`null`, a reassignment sets both to the new team consistently. Also found and eliminated `promptDefaultTeam`'s own **independent duplicate** of this exact write logic (a second, drifted copy — see [[feedback-mirrored-algorithm-copies-diverge]]) that additionally lacked the PR #68 uuid fix's `await` and had the same `team_text`-only gap; it now delegates to `_setEmployeeDefaultTeam` instead of maintaining its own copy, so there's only one write path left to keep correct.

---

## 8v. Route detail modal from Employee Hours

Hours Report already let Tom tap an employee to expand a 5-day breakdown, and tap a specific day pill to open an edit-hours overlay (`showEmpDayDetail`: start/end time, lunch, team, extra tasks — a load-bearing correction workflow, not new in this PR). Tom asked for a NEW capability: tap a day → a read-only modal showing that day's full GPS route (same level of detail as the Live Tracking timeline), total drive time, and any incidents/notes — using the same modal-over-current-view pattern as PR #70's client card.

**Scope call, flagged rather than assumed**: the day pill's tap already opens the edit-hours overlay, and that overlay is how Tom corrects hours day-to-day — replacing its tap behavior outright would have silently removed discoverability of an established workflow. Instead, added a "🗺️ Route" button inside `showEmpDayDetail`'s header that opens the new route-detail modal (`openHoursRouteDetail`/`closeHoursRouteDetail`) stacked on top. Both this modal and the edit-hours overlay it's opened from are non-destructive overlays that never touch the Hours Report's own DOM or scroll position, so "Hours Report stays underneath at the same scroll position, employee list still expanded" holds regardless of how many overlays are stacked above it — there's nothing to explicitly restore.

**Implementation**: reuses the same device-resolution + trip-fetch + reverse-geocode pipeline `showEmpStops` already uses for that day/team (`_resolveTeamDevice`, `_geotabCall('Get', {typeName:'Trip', ...})`, `reverseGeocodeTrips`), and renders stops with the same `.tvc-stop-row` markup/classes Live Tracking's `_renderGPSStopRow` uses, for visual consistency. Total drive time is computed independently of the stop-row abstraction — summing each Geotab trip's own start→stop duration — so idle time the vehicle spends parked *between* trips is correctly excluded, only time actually spent driving counts. Incidents/notes: neither `incidents` nor `job_issues` has an employee+date query (both are keyed by `job_id`/`client_id` only), so the section resolves that day's team jobs first (`jobsForDate(date).filter(team)`, the same team+date job filter Live Tracking already uses) and fetches `listForJob` against both tables per job — a best-effort join, not a direct query, called out in the PR description as the scope's honest limit. Map rendering was explicitly named optional/deferrable by Tom ("can be added later") and is not included in this PR.

Escape/backdrop-click/X close, with the same listener add/remove discipline as PR #70's client card (`_hrdKeyHandler`), and every async section (route, incidents) re-checks its target DOM element still exists before writing, so a closed-and-reopened-for-a-different-day modal can't have a stale in-flight fetch paint over the wrong day.

---

## 8u. GPS day-start algorithm: two mirrored copies had silently diverged (loadWeekHours never got the v11.0.29 fix)

Tom reported an employee's GPS-derived day-start was wrong: system said 8:18am, the real sustained depot departure was 9:11am. His spec: day-start is the LAST depot-departure trip whose next return-to-depot is ≥90 min away (or never returns) — `SUSTAINED_AWAY_MIN_MIN`, unchanged from v11.0.23.

**What was actually happening.** `loadWeekHours()` (feeds the Hours Report — where Tom saw the 8:18 figure) and `_computeGPSDayWindow()` (Live Tracking) are two independently-maintained copies of the same algorithm, explicitly commented as "mirrors" of each other. They had diverged:

- `_computeGPSDayWindow` received a v11.0.29 fix: its primary loop (candidates = `validTrips.filter(_isDepotStart)`) is *always empty* — Geotab's Trip API never returns `trip.startPoint` or `trip.startAddress`, for any trip, confirmed live (see `project_geotab_trip_startpoint_never_returned` memory) — so v11.0.29 added a fallback that scans every trip for the first one not followed by a quick depot return.
- `loadWeekHours` **never got that fix.** Its fallback, when the same always-empty primary loop found nothing, was simply `trueStart = validTrips[0].start` — no sustained-away check at all. That's "day-start = first GPS ping of the day," exactly the naive algorithm Tom's spec explicitly rejects (his diagnostic checklist named it as option 1 of 3 possible wrong algorithms). Whatever Ines's vehicle's first trip of the day was — even an unrelated early errand — always won outright, regardless of `SUSTAINED_AWAY_MIN_MIN`, because that threshold only lived inside the dead `depotDepartures` loop it never reached.

Separately, `_computeGPSDayWindow`'s v11.0.29 fallback was *also* still wrong, just less severely: it scanned all trips for the first one not followed by a quick depot return, but never required the candidate to have actually departed the depot at all. An early trip completely unrelated to the depot (a personal stop, leaving from home) could still get crowned "the start" merely because nothing routed through the depot again soon after it — the same failure class by a different path.

**Fix.** Extracted one shared `_findTrueDepotDepartureTrip(validTrips, isDepotStop, sustainedAwayMinMin)`, used by both call sites, so this can't silently fork again. Since a trip's own start-side fields are unusable, "did this trip depart the depot" is inferred from the **preceding** trip's stop instead — reliable, because `stopPoint`/`stopAddress` *are* returned by Geotab. A trip only becomes a start candidate if the trip immediately before it (same day, same device) ended at the depot; the first such candidate whose next depot return is sustained (or never happens) wins. The very first trip of the day has no preceding trip to confirm it, so it's deferred to the existing last-resort fallback (`validTrips[0].start`) rather than auto-qualifying or auto-disqualifying — this preserves the common "vehicle parked at the depot overnight" case (the fallback lands on the same trip the main loop would have picked anyway) while no longer letting an unconfirmed first trip outrank a later, actually-confirmed departure.

Verified against the documented v11.0.23 examples (quick gas-run bounce still correctly skipped) plus a reconstruction of Tom's reported case (an unrelated early trip followed by a genuine depot visit, then the real sustained departure) — the new algorithm picks the later, depot-confirmed trip; the old `loadWeekHours` fallback and the old `_computeGPSDayWindow` fallback both reproducibly pick the earlier, wrong one on the same data.

Note: neither Geotab's live trip history nor per-day trip logs are persisted anywhere queryable (no Supabase table stores them — they're fetched live per request), so this diagnosis is grounded in the code path itself and reconstructed test data matching Tom's reported timestamps, not a direct query against Ines's actual trip rows for that day. If the fix doesn't fully resolve what Tom sees next, the next step would be temporarily logging the real trip list + candidate evaluation for a specific team/day to compare against live Geotab data directly.

---

## 8t. Optimistic team-assignment render was clobbered by its own "readiness" merge (PR #69 didn't actually fix the lag)

PR #69 (§8r) made `confirmTeamAssign`/`quickAssign` fire their Supabase write without awaiting it, then immediately call `renderTeamManager()` for an "optimistic" repaint. Tom reported the lag was unchanged. Root cause: `renderTeamManager()`'s first action, before building any HTML, was an *unconditional* call to `_mirrorPentaAssignmentsToInMemory()` (added in an earlier PR to close a stale-data race on modal open — see the "Bug fix" comment at the top of `renderTeamManager`). That function reads `PentaAssignments.listSync()` — the **server-confirmed** cache — and lets "Supabase wins" overwrite `dailyAssignments` back to whatever's still in that cache for any key present there.

`PentaAssignments.assign()` has no internal optimistic update: `_cache`/`_byKey` only change *after* the real `await sb.from(...).insert(...)` resolves. So at the exact moment of the immediate optimistic render — a write in flight, not yet confirmed — `listSync()` still returns the OLD row. The mirror step read that stale cache and clobbered the fresh optimistic value `assignEmployee()` had just written synchronously, moments before it was ever painted. The grid only showed the correct team once the real round-trip completed and `PentaAssignments`' `onChange` listener re-mirrored and re-rendered — which *is* "click a button, wait, then it registers." PR #69's fire-without-awaiting change was real and necessary, but it painted a render that immediately undid itself.

**Fix.** `renderTeamManager(opts)` now accepts `{skipMirror: true}`, used only by the immediate post-write calls in `confirmTeamAssign` and `quickAssign` (the latter had the identical bug — it's the Team Manager grid's own "quick-assign an unassigned employee" buttons, same `dailyAssignments`-then-immediate-render pattern). That specific render paints straight from the already-correct in-memory `dailyAssignments` instead of re-deriving it from a cache that's momentarily stale by design. Every other caller (initial mount, date change, the server-confirmed re-render `PentaAssignments.onChange` triggers after a real write lands) keeps the normal merge — they aren't racing an in-flight write of their own, and still want the authoritative state. `quickAssign`'s failure path (previously silent — no rollback, no re-render at all) now also triggers a normal (mirroring) re-render on rejection, so a failed quick-assign self-corrects visually instead of leaving the grid showing a team that never persisted.

---

## 8s. Client card modal from GPS stops

Live Tracking stop rows already matched a GPS stop to a client (§8m's geo-first tiering, `matchStopToClientGeo`) and rendered the client's name, but the name was inert text. Tom asked for it to be tappable, opening a read-only client card (address, phone, notes, recent cleans, payment history, health score) as an overlay on top of the Live view — for all three match-confidence tiers (high, medium/unscheduled, low), not just high-confidence scheduled visits.

**Blocking gap found first: no client id survived the match.** `matchStopToClientGeo` returned only `{name, confidence, scheduled, distFt}` — no id. Re-resolving the clicked name back to a client via `PentaClients.findClient(c => name includes c.fn/c.ln)` would reintroduce the exact name-collision bug just fixed in PR #68 (§8q) — Manna's real data has 7+ groups of clients/employees sharing a name. Fixed by extracting the address/string-matching logic that used to live directly in `matchStopToClient()` into a new `matchStopToClientObj(addr, teamJobs)`, returning `{name, id}` (or `null`) instead of a bare string. `matchStopToClient()` is now a one-line wrapper around it (`return m ? m.name : ''`) so every existing caller (map popups, etc.) is unaffected. `matchStopToClientGeo()` now threads `id` through both of its branches — the geo-distance match (`id: best.id`) and the address-string fallback (`id: matchObj.id`, and `scheduled` is now computed by comparing `tj.clientId === matchObj.id` directly instead of the old fragile `name.includes(c.fn) && name.includes(c.ln)` substring check).

**The modal (`openGPSClientCard`/`closeGPSClientCard`, new static shell `#gps-client-card-modal`, z-index 10050 — above every existing overlay's ceiling of 10000).** Built as a bottom sheet appended on top of the existing Live Tracking view; it never touches that view's DOM or scroll container, so "Live view stays at the exact scroll position and filter state on close" needed no explicit save/restore — there's nothing to restore because nothing underneath ever changed. Closes via the X button, clicking the dimmed backdrop (`onclick="if(event.target===this)closeGPSClientCard()"`, matching every other overlay in the file), or Escape — this file had no existing Escape-to-close pattern anywhere, so the listener is added in `openGPSClientCard` and explicitly removed in `closeGPSClientCard` to avoid leaking a global `keydown` handler across repeated open/close cycles. "Edit" routes to the existing `openClientEdit(clientId)` edit form (closing this card first) rather than duplicating any editing UI.

**Client name only becomes clickable when a real match with an id exists** — depot stops (`s.isDepot`, labelled "Office", `_match` is `null`) and "possible lunch" rows are unaffected; the underlined-button treatment applies to all three confidence tiers uniformly, including low-confidence and medium/unscheduled matches (which keep their `UNSCHEDULED` badge next to the now-clickable name).

**Health score and payment history are async, loaded after the modal opens** rather than blocking it. Health uses `PentaClientHealth.listLatest()`, cached module-level per session (avoids re-fetching ~300 clients' scores on every card open) — critically, the lookup key is the client's **uuid** (`c.uuid`, i.e. `clients.id`), not the legacy `external_id` (`c.id`): `client_health_scores.client_id` targets `clients.id`, the opposite of how `jobs.client_id` targets `clients.external_id` (see the `project_client_id_fk_targets_differ` memory this session already flagged in §8-era work) — using `c.id` here would have silently shown "No health score yet" for every client. Payment history uses `PentaPayments.listForClient(clientId, {})`, which internally resolves either id style via `_resolveClientUuid`, so the external-id form is fine there. Every async section (health, payments) writes a concrete fallback string on every path — loading, empty, and error — never leaves stale "Loading…" text or a blank element if the card is closed mid-fetch (each handler re-checks `document.getElementById(...)` before writing, since the modal DOM element persists across opens and a stale in-flight fetch for a previously-viewed client must not paint over the currently-open one).

---

## 8r. Optimistic team-assignment UI updates

Tom reported noticeable delay on the Schedule tab's team modal — "click a button, wait, then it registers." Profiled the flow and found two separate causes, both fixed.

**Cause 1 — UI gated behind the network round-trip.** `confirmTeamAssign()` used to `await assignEmployee(...)` before touching the DOM at all — closing the modal and re-rendering the grid were both blocked on the full Supabase write completing (a team *change*, as opposed to a first-time assignment, means TWO sequential writes inside `PentaAssignments.assign()`: soft-delete the old row, then insert the new one). `assignEmployee()`'s local write (`dailyAssignments`/`dailyAssignmentDetails`) already happens synchronously, *before* its own first `await` — calling it without awaiting means that write is already applied by the time the next line of `confirmTeamAssign` runs. Rewritten to not await: the modal close, re-render, activity log, and `recalcTeamTimes` all now happen immediately against the optimistic state; the actual network write continues in the background via `writePromise.catch(...)`. PR #64's rollback-on-failure (revert `dailyAssignments`/`dailyAssignmentDetails`, toast an error) is unchanged inside `assignEmployee()` — the `.catch()` handler just additionally re-renders (and re-runs `recalcTeamTimes`) so the grid visibly reflects the revert instead of continuing to show a change that never persisted. `confirmTeamAssign` is no longer `async` — no caller awaited it (both call sites are inline `addEventListener` closures), so this is a safe signature change.

**Cause 2 — unrelated GPS data re-fetched on every render.** `renderTeamManager()` unconditionally re-fetched the full Geotab device list (a live external API round-trip) *and* re-resolved every team's device assignment (`_resolveTeamDeviceMap`, N parallel Supabase RPCs) on **every single call** — including a plain employee add/remove/day-off save that has nothing to do with GPS vehicles. Added a per-date cache (`_tmgrGpsCache`) that's reused across renders for the same date; only re-fetched when the date picker actually changes (a different cache key) or `_invalidateTmgrGpsCache()` is explicitly called after a real device-assignment change (`setTeamDeviceAssignment`, the only place a vehicle assignment is genuinely mutated). A run of several employee saves in a row now triggers exactly one device fetch total, not one per save.

**Scope note**: this PR covers the Schedule tab's `confirmTeamAssign`/`renderTeamManager` flow specifically (Tom's explicit ask). Staff → Teams' separate `staffTeamAddEmployee`/`staffTeamRemoveEmployee` (§8q) still await their write before updating the UI — same general principle would apply there, but it's a distinct surface not covered by this request.

---

## 8q. Staff → Teams "Remove does nothing" — name-based resolution bug

Tom reported clicking "Remove" on an employee in the Staff → Teams team builder modal appeared to do nothing — no error, no visual change. Investigation found two compounding bugs, both caused by resolving employees by *name* instead of a stable id, in `getUnifiedRoster()` and `_setEmployeeDefaultTeam()` (index.html).

**Bug 1 — silent roster drop.** `getUnifiedRoster()` deduped its output by name (`existsByName`) as well as `legacy_roster_id`. That dedup only ever made sense while the (now permanently empty, retired v10.5.22) hardcoded `EMPLOYEE_ROSTER` array could collide with facade rows loaded from Supabase — with `EMPLOYEE_ROSTER` always `[]`, the check was comparing facade employees against *each other*. Confirmed live: Manna's real roster currently has 7+ groups of employees sharing a normalized name ("Tom Manna" ×2, "Keyshla -" ×2, "Viviana -" ×2, "Test -" ×2, "Maria Vieira" ×2, "Maria Ventura" ×2, "Tom -" ×3). Every employee after the first in each group was completely invisible to every `getUnifiedRoster()`-based view — Staff → Teams *and* the Schedule tab's Team Manager, which shares this same function — impossible to select, add, remove, or manage at all.

**Bug 2 — wrong-record mutation.** Even for the employee that *did* survive bug 1 (the first of a duplicate-name group), `_setEmployeeDefaultTeam()` re-resolved the Supabase row to write via `PentaEmployees.getByName(emp.name)` — a case-insensitive, first-match-wins lookup with no uniqueness guarantee. Clicking Remove on a same-named employee silently wrote to whichever duplicate happened to be first in `PentaEmployees._cache`'s iteration order — not necessarily the one actually clicked. This reproduces exactly as "no visible feedback": the employee Tom was looking at doesn't change (a *different*, same-named employee got mutated instead), with no error surfaced anywhere. Live data corroborates this: two employees (Melissa Manna, "tomas manna") had `team_text` cleared to `''` with `updated_at` timestamps from minutes before this investigation — plausibly Tom's own recent removal attempts landing on the wrong record, or on a record whose change was invisible per bug 1. Flagged for Tom to review; not corrected here, since intent can't be inferred from the data alone.

**Fix**: `getUnifiedRoster()` no longer dedups by name — only by `legacy_roster_id` (a legitimate check; two facade rows genuinely can't share one legacy id) — and now carries the real Supabase `employees.id` through as `emp.uuid` on every returned row (mirroring the `id`/`uuid` split `PentaClients` already uses for the same reason). `_setEmployeeDefaultTeam()` and its sibling `promptDefaultTeam()` (the Schedule tab's "⭐ Set Default" button, same `getByName` pattern) both now write via `emp.uuid` directly — no name lookup, no ambiguity — with `getByName` retained only as a defensive last-resort fallback if `uuid` is ever unexpectedly absent.

**Known follow-up, not addressed here**: duplicate-named employees now correctly all appear in Staff → Teams' member/dropdown lists, but are visually indistinguishable by name alone (e.g., two identical "Tom Manna" rows). Functionally correct (each has a distinct, correctly-targeted `id`/`uuid`) but a UX polish item for a future pass if Tom wants a disambiguator (e.g., hire date, phone, or an id suffix) shown when names collide.

---

## 8p. Structured "Day off" categories (migration 086)

Previously "Day Off" was a single flag (`daily_assignments.team = 'OFF'`, collapsed to `null` by every reader) with no way to say why someone is off. Adds a categorized status alongside the existing OFF mechanism.

**Schema**: `daily_assignments` gains `status_type text` (nullable — only meaningful on an OFF row, enforced by `CHECK (status_type IS NULL OR team = 'OFF')`) constrained to 5 values (`CHECK (status_type IS NULL OR status_type IN ('vacation','excused_absence','unexcused_absence','no_call_no_show','not_scheduled'))`) and `notes text` (free text, optional context). Audit "who": `created_by` has existed on this table since its original migration but was never actually populated by any INSERT path — confirmed live, 0 of 352 existing rows had it set. Fixed with `ALTER COLUMN created_by SET DEFAULT auth.uid()`, the standard Supabase pattern — works for direct PostgREST inserts (not just `SECURITY DEFINER` RPCs), needs no browser-side code to remember to pass it, and can't be spoofed by the caller. "When" was already covered by `created_at`'s existing `now()` default.

**`PentaAssignments.assign(dateStr, team, employeeId, extra)`**: new optional 4th param `{status_type, notes}`, included on insert. The existing "same team = no-op" short-circuit was extended to also compare `status_type`/`notes` — otherwise picking a *different* category while an employee is already marked OFF (e.g. correcting "Unexcused" to "Excused" after the fact) would silently do nothing, since `team` alone hadn't changed. A category change now correctly supersedes the old row (soft-delete + insert), which means category corrections get the same audit trail as team changes for free.

**Browser mirror**: a new `dailyAssignmentDetails` object (keyed identically to `dailyAssignments`, holding `{status_type, notes}`) is populated by `_mirrorPentaAssignmentsToInMemory()` alongside the existing team mirroring. Deliberately *not* persisted to `localStorage` — always re-derivable from `PentaAssignments`, so it doesn't carry the dual-write/staleness risk `dailyAssignments` itself has (see §8n / `feedback_dailyassignments_dual_system_race`). `getEmployeeDayOffInfo(employeeId, dateStr)` reads it, gated strictly on `dailyAssignments[key] === 'OFF'` first. `assignEmployee()`'s existing optimistic-write-with-rollback-on-failure pattern (§8n) was extended to cover the detail object too — a failed write can't leave a phantom category pointing at a team value that got rolled back.

**UI**: tapping "Day Off" in the employee assignment picker (`editEmployeeAssignment`) now opens a submenu (swapped into the same sheet, not a nested modal) with the 5 category buttons plus an optional notes field, populated from the current category/notes if one's already set. Tapping a category saves immediately (same single-tap pattern the team buttons already use) with whatever notes were typed first. The picker's header and the Team Manager's "Unassigned" list both show the category label (e.g. "Day Off — Vacation") instead of a bare "Unassigned" that couldn't distinguish a real day off from a genuinely unassigned employee.

**Explicitly out of scope** (per Tom): downstream consumers — churn card, HR reports, vacation tracking — are not built here. This PR only captures the data correctly and exposes the categorized status where "Day Off" already showed before.

**Follow-up — grid quick-action (PR #67).** PR #66's submenu was only reachable through `editEmployeeAssignment` (the full team-list picker, opened via "Move"/"Assign"). Tom reported clicking "Day Off" on the Schedule tab's Team Manager grid still showing "old flat behavior" — diagnosis found no second, unwired write path (the only other `'OFF'` writers are three Claire voice-command handlers, which can't show a UI submenu at all), so rather than continue chasing a possible caching issue, added a genuinely new, more direct entry point: a "🏖 Off" button on every employee row in `renderTeamManager` (both team-card rows and both Unassigned-section listings) that opens the category submenu immediately via a new `openDayOffPicker(employeeId, dateStr)` wrapper — no team-list step first. It builds its own bare overlay/sheet and hands off to the *exact same* `_showDayOffCategoryPicker` component `editEmployeeAssignment` already used — same 5 categories, same notes field, same `confirmTeamAssign`/`assignEmployee` write path — so there is no second implementation to keep in sync. Because both entry points read via the same `getEmployeeDayOffInfo`/`dailyAssignmentDetails`, a category set from either surface is immediately consistent on the other (grid badge and modal header both update after either save, since `confirmTeamAssign` always re-renders `renderTeamManager` regardless of which button triggered it).

---

## 8o. Live Tracking date headers for 7d/30d activity windows

Tom's ask: when viewing 3d/7d/30d in Live Tracking's activity-window selector, group stops by calendar day with a "Monday, Aug 3"-style header before each day's activity, most recent day at top. The 24h view is unchanged (no headers — one day, no ambiguity).

`renderGPS()`'s per-vehicle stop-row rendering (was a single `stopList.map(...)`) is split into a shared `_renderGPSStopRow(s, includeDriveInfo)` template plus two render paths: the 24h path renders `stopList` flat, unchanged; the rolling-window path groups `stopList` entries by business-timezone calendar date (`toLocaleDateString('en-CA', {timeZone})` as the grouping key, `{weekday:'long', month:'short', day:'numeric'}` for the header label), sorts groups descending (most recent day first), and renders each group's header followed by its stops in their original chronological order.

Two things had to change to make grouping/reordering safe:
- **"Now" label** (the currently-open, no-`outTime` stop) used to be identified by array position (`si === stopList.length - 1`). Position no longer implies recency once groups reorder the render, so it's now found by object reference (`s === stopList[stopList.length - 1]`) — `stopList` itself stays in chronological order regardless of render order.
- **Drive-time info** (distance/duration between consecutive stops) used to show for every stop after the first (`si > 0`). Now it's scoped to "the first stop within its own day's group" (`si2 > 0` inside each group) — a 3am arrival on a new day isn't meaningfully "a drive" from yesterday's last stop, and showing it there would misrepresent an overnight gap as a short hop.

The existing per-row date-stamped time format (added when the activity-window feature first shipped, to disambiguate cross-day stops in a flat list) was removed — the new day headers make that redundant, so times render as plain `h:mm AM/PM` in both view modes again.

---

## 8n. Schedule tab team-assignment save bugs (migration 085)

Two reported symptoms: (1) opening a team on the Schedule tab didn't show the real assignment until closed and reopened, (2) morning assignment changes reverted to defaults by afternoon.

**Architecture**: two parallel systems have coexisted since Sprint 10. `window.PentaAssignments` (index.html ~8255) is the real, Supabase-backed source of truth for `daily_assignments`. But the actual read/write surface every UI call site uses — `getEmployeeTeam`, `getTeamEmployees`, `assignEmployee` (index.html ~25810-25890) — is a *legacy*, module-level `dailyAssignments` object backed by `localStorage`, never PentaAssignments directly. A `_mirrorPentaAssignmentsToInMemory()` function (index.html ~13091, registered via `PentaAssignments.onChange` + `.ready()` + a 1.5s backup timer) merges Supabase's cache into `dailyAssignments` asynchronously, on its own schedule — independent of when any UI actually reads it.

**Symptom 1 root cause**: `renderTeamManager()` (the Schedule tab's team modal) read `getEmployeeTeam()` — i.e. `dailyAssignments` — without ever waiting for the mirror to have run. If the modal opened before `PentaAssignments` finished its first hydrate+merge cycle (a real race, not hypothetical — the code's own `v10.5.25` comment already documents "Reopen the dialog in a moment" as a known workaround for the *fully-empty-roster* case of this exact race), it silently showed default/stale team assignments instead of the real override. Closing and reopening worked only by accident — enough time had usually passed for the mirror to catch up. **Fix**: `renderTeamManager()` now explicitly `await`s `PentaAssignments.ready()` and calls the merge function directly at the top of every render, closing the race instead of relying on timing luck.

**Symptom 2 root cause**: `assignEmployee()`'s Supabase write was fire-and-forget (`.catch()` for a toast, never awaited) with **no rollback** — the exact bug class already hit and partially fixed once before (`v10.5.23`'s comment describes an earlier, near-identical incident: "assigned Viviana + Melissa, only saw them on the dispatch view... the Supabase writes never landed"). If the write failed for any reason (network blip, session hiccup), the optimistic local write to `dailyAssignments` stayed in place regardless — this session kept showing the change as saved while nothing durable existed anywhere else, and any later read that goes through the real source of truth (a fresh page load, a different device, or even this session's own next mirror cycle once corrected) shows the pre-change state. **Fix**: `assignEmployee()` is now `async`/awaited and rolls back the optimistic write on failure (restoring the prior value, or removing the key if there wasn't one) before rethrowing. `confirmTeamAssign()` (the modal's Save handler) awaits it, only logs to the activity feed / recalculates team job times on actual success, and unifies the previously-separate, non-rolled-back `'OFF'` branch through the same path.

**Defense in depth (migration 085)**: `PentaAssignments.assign()`'s own code comment has always claimed a unique constraint on `(business_id, date, team, employee_id) WHERE deleted_at IS NULL` exists server-side. It didn't — confirmed via `pg_constraint`, only a primary key and FKs. No duplicate active rows existed in production at time of fix, but nothing prevented a race (two near-simultaneous `assign()` calls) from creating two active rows for the same employee+date with different teams — and since neither `PentaAssignments._byKey` nor the mirror resolve "the" team for a key by recency (just whichever row sorts last in an unordered array), a latent duplicate would make which team "wins" effectively random across renders. Added `daily_assignments_active_unique` on `(business_id, date, employee_id)` (deliberately *not* including `team`, unlike the aspirational comment — the whole point is one team per employee per day) `WHERE deleted_at IS NULL`. A future race now surfaces as a loud, handled write failure (caught by the symptom-2 fix above) instead of silent duplicate data.

---

## 8m. Address-to-client geofence match fix (migration 084) — unscheduled visits, geocode backfill

Reported case: a stop at "1 Caulfield Rd, Wayland" (a real client, Susan Devlin) rendered as "possible lunch/break" in Live Tracking. Two independent, compounding root causes:

**Data cause**: `clients.address` was stored as "1 Caulfied Rd." (typo, missing an "l"). Browser-side `PentaGeocode` (index.html ~6232-6324, free Nominatim → Photon fallback, called on client save/edit) had never successfully geocoded it — `geocode_status='failed'`, `lat`/`lng` both NULL. Fixed: corrected the address to "1 Caulfield Rd." and geocoded it directly (lat 42.3236444, lng -71.3555205 — confirmed 13m/43ft from the actual live Geotab GPS stop for that visit). One other active client (Alexzandra McBeth, "15 Lovell Pl", Athol) also has `geocode_status='failed'` and could not be auto-geocoded by either provider on this pass — left flagged for manual address correction (see UI flag below). Two `draft_*` clients have empty addresses (never geocodable) and were left untouched. Before: 4 active clients missing lat/lng (2 real, 2 empty drafts). After: 1 real client fixed, 1 real client still flagged, drafts unchanged.

**Resolver cause**: `resolve_job_from_gps_stop` (originally migration 075, most recently 079) only ever matched a client within a tight 61m (200ft) radius, and required a scheduled job for that team+client+day to register as anything but `'none'` beyond the closest 30m — an unscheduled visit (walk-through, same-day add, follow-up) at a real, correctly-geocoded client's address still failed to match. Migration 084 restructures the tiering, entirely by distance now (schedule status no longer gates whether a match happens at all, only which confidence tier it gets):

- `high` — within 200ft AND a scheduled job exists for that team/date
- `medium` — within 200ft, no scheduled job (**unscheduled visit**)
- `low` — 200-400ft buffer zone, scheduled or not (looser GPS fix, or an unscheduled visit a bit farther from the pin)
- `none` — no client within 400ft

`job_id` is still populated whenever a scheduled job exists, independent of confidence tier. The outer search radius (`p_radius_meters`) default widened from 61m to 121.92m (400ft) so the `low` tier is reachable. **`poll-geotab-clocks`** (the only current caller) is updated to *not* pass an explicit `p_radius_meters` (uses the new 400ft default) but gates actual `write_job_gps_clock` calls to `confidence IN ('high','medium')` explicitly rather than bare `job_id` truthiness — so the wider search radius only widens what can be *labeled*, not what can trigger a payroll clock write. (In practice this EF has still never run — `poll_geotab_runs` remains empty, blocked on the Vault `service_role_key` secret Tom hasn't seeded.)

**Browser mirror (`matchStopToClientGeo`, index.html, near `matchStopToClient`)**: Live Tracking's stop-list rendering doesn't call the SQL resolver at all (confirmed: `gps_match_log` is empty even for stops that clearly happened) — it's a separate, purely client-side pipeline. Added a JS mirror of the same 200ft/400ft tiering, run against `PentaClients`' in-browser `lat`/`lng` (already loaded, see `_transformRow`, index.html ~5458-5505) via a new `distFeet` helper (index.html, next to `distKm`). Falls back to the pre-existing string-based `matchStopToClient` only when the stop has no lat/lng (Geotab never returns `startPoint` — see §8l's `project_geotab_trip_startpoint_never_returned`) or no client is geocoded close enough. Rendering: `high` → plain client name; `medium`/`low` (not `scheduled`) → client name + an amber "UNSCHEDULED" badge (Tom's explicit ask: visible enough to spot patterns — which teams make unscheduled stops, which clients — without disrupting the timeline); `none` → falls through to the existing duration-based "possible lunch/break" heuristic, unchanged. Other `matchStopToClient` call sites (map popups, route-optimizer) are untouched — out of scope for this fix.

**UI flag for failed geocodes**: client list cards (index.html ~14308-14326) now show a small red "📍⚠️ Address needs review — couldn't locate this address" line under the address whenever `geocode_status === 'failed'` and the client has a non-empty address — so a manager can spot and fix records like McBeth's without needing to know to check `geocode_status` directly.

---

## 8l. Live Tracking: non-blocking load, depot-blip window fix, stale hint, multi-day activity window

Follow-up to §8k, addressing two more reported symptoms plus a requested feature.

**1. Loading state no longer blocks on reverse-geocoding.** `loadGPSData()` used to `await` both `reverseGeocodeTrips` and `reverseGeocodeVehicles` (GetAddresses calls) before rendering anything or clearing "Loading...". Split into two phases: the core fetch (devices, statuses, trips, team-device resolution) renders the map + fleet list immediately, with stop addresses falling back to raw coordinates; a background pass (`_refineGPSAddresses`) then reverse-geocodes and re-renders once real addresses are in, showing a small "Some data loading…" indicator (`#gps-partial-indicator`) while in flight. Guarded by a monotonic `_gpsLoadToken` so a slow background pass from a load the user has since superseded (Refresh clicked again, activity window changed) can't overwrite newer data or force a stale re-render.

**2. `_computeGPSDayWindow` depot-blip fix (root cause of "only a few stops").** Confirmed live: Geotab's `Trip` API never actually returns `startPoint` — not just "often" for the first trip of the day as the original v11.0.28 comment assumed, but for every trip, always. `depotDepartures` (which gates `trueStart`) was therefore permanently empty, so `trueStart` silently fell back to the chronologically first trip of the day regardless of what it was. When that first trip was itself a brief near-depot idle blip (engine bump, vehicle hasn't really left) whose own stop was also inside the depot radius, it doubled as its own "late depot arrival" moments later, collapsing `trueEnd` to almost the same instant as `trueStart` and truncating the entire rest of the real day out of the window. Reproduced live against today's real Manna data: 3 of 8 teams were losing 60-90% of a real day's stops to this (S1: 8 real trips → 1 shown; B5: 8 → 2; M3: 7 → 3). Fix: when no trip is flagged `_isDepotStart` (now always the case), scan every trip in chronological order for the first one that isn't itself a same-blip depot round-trip, using the identical "was this actually followed by real away-time (≥90min)" test already used for `depotDepartures`.

**3. Stale-activity hint.** A resolved team/device with zero stops in the current window now shows "No activity in last 24h" (contact <24h ago) or "Last activity Nd ago" (contact ≥24h ago) under the location line, computed from `lastContact` (`DeviceStatusInfo`'s live last-heard-from timestamp) rather than trip data — so it stays accurate even when the window logic above legitimately finds nothing (a genuinely idle team) and is indistinguishable from a broken view otherwise.

**4. "Show older activity" window (`#gps-activity-window`).** New selector: Last 24 hours (default), 3 days, 7 days, 30 days — for cases that aren't "today's route" (verifying employee hours, investigating a client issue, matching Coast fuel card transactions). "Last 24 hours" preserves the existing single-calendar-day behavior driven by the date picker (best quality: `_computeGPSDayWindow`'s depot-aware start/end trimming only makes sense for one team's one-day route). The 3d/7d/30d options are a genuinely different mode — a rolling window ending *now*, spanning multiple calendar days — so the day-boundary window is skipped entirely (every fetched trip shown verbatim) and the date picker is hidden (it has no meaning for "last N days ending now"). `resultsLimit` scales with the window (500/1,500/3,000/6,000) since a fixed 500-trip cap that's plenty for one team's one day would silently truncate a real multi-day pull for a 15-device fleet; a `#gps-truncation-notice` banner surfaces when the cap is hit. Stop timestamps include the date (not just time) when in a rolling window, since stops can now span multiple calendar days. Selection persists per-session via `sessionStorage` (`gps_activity_window`), defaulting to 24h on a fresh session.

Known scoping decision: team→device resolution (`_resolveTeamDeviceMap`) always resolves against the *current* date regardless of the selected activity window — a 30-day pull shows that team's *currently assigned* vehicle's full trip history, not a day-by-day reconstruction of whichever vehicle was assigned on each individual day. Simpler and matches the stated use cases (verifying hours, investigating an issue) better than day-by-day reassignment tracking would.

---

## 8k. Live Tracking "Could not load fleet data" — unguarded map init (fix/gps-map-init-guard)

Reported as a regression after migration 083 (the `get_team_device` CTE fix, SQL-only, no browser JS touched). Every other layer was ruled out live before the fix: `business_geotab_integrations`/`business_geotab_sessions` healthy, `get_team_device` returns clean results for all 8 Manna teams, direct Geotab re-auth succeeded, and `_resolveTeamDevice`'s RPC call already has its own local try/catch so it can't be the source anyway.

The actual bug: `renderGPS()` (`index.html`, called synchronously as the last step inside `loadGPSData()`'s `try` block, after every Geotab/Supabase fetch has already succeeded) ended with an **unguarded** `initMap(); updateMapMarkers();`. `gpsInit()`'s own copy of that same call was already wrapped in try/catch — this second call site, which fires on every refresh/rename-save/hide-toggle (not just the first tab load), was not. `initMap()` itself was also missing three defenses that `renderInlineScheduleMap` (the Schedule tab's Leaflet map, ~line 40863) already needed to add for this exact failure class: a `typeof L === 'undefined'` guard, a stale `container._leaflet_id` reset, and a container-exists check.

The dangerous case: if `L.map('gps-map', ...)` throws partway through construction — Leaflet stamps `container._leaflet_id` as its first internal step, before the `gpsMap =` assignment completes — `gpsMap` stays `null` while the DOM stays stamped. Every later call then hits Leaflet's own `"Map container is already initialized."` on that same stamped container and throws again, forever, for that page session: a self-perpetuating trap, not a one-off flake, which matches a persistent (not transient) regression report. That throw propagated out of the unguarded `renderGPS()` call site into `loadGPSData()`'s catch, replacing the entire fleet list with "Could not load fleet data." even though the underlying data load had fully succeeded.

Fix: `initMap()` now clears a stale `_leaflet_id` stamp before calling `L.map()` (mirroring `renderInlineScheduleMap`'s existing pattern) and no-ops if `L` or the container isn't available; `renderGPS()`'s call site is now wrapped in try/catch matching `gpsInit()`'s. A Leaflet-layer hiccup can no longer take down the whole Live Tracking view — worst case, the vehicle list still renders and only the map silently skips that refresh.

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

- **093** — Team Color (§8am). `teams.color` gets a `#3B82F6` DEFAULT, a `teams_color_format_check` CHECK (`^#[0-9A-Fa-f]{6}$`), and a sequential-preset backfill for any row still missing a color. Adds `teams`' first-ever audit trigger (`audit_teams_capture` + `'teams' → 'team'` in `audit_log_capture()`).
- **092** — Client cancellation flow (§8ak). Adds `clients.cancellation_reason` (CHECK'd against 9 preset values), `cancellation_notes`, `cancelled_at`, `cancelled_by` (→ `users.id`). Extends `audit_log_capture()` with a `clients` `cancelled_at` NULL→non-NULL branch (mirrors the existing `jobs` one) so cancellations auto-label `action_type='cancelled'`.
- **091** — GPS Verification start date scaffolding (§8ai). Adds `businesses.gps_verification_start_date date` (nullable). Column only — the cross-check logic that will read it is separate, deferred future work.
- **090** — Backfill stale `scheduled` jobs (§8ah). One-time data fix, no schema change: `UPDATE jobs SET status='completed' WHERE business_id=<manna> AND status='scheduled' AND date < CURRENT_DATE` — 22 rows, $2,608.
- **089** — Maids importer batching (§8ad). Drops `import_maids_data`. Adds `import_maids_start` (wipe + client upsert + review-flag sweep + provisional `import_runs` row), `import_maids_jobs_batch` (job upsert for one batch, idempotent), `import_maids_finish` (derived-stat recompute + final `import_runs` totals). Adds the `import_runs_update` RLS policy migration 087 was missing.
- **088** — Maids importer "Option D" (§8ac). `jobs` gains `scheduled_start_time_adjusted boolean` and `scheduled_start_time_original time`. New `maids_import_duplicates` table (business_id, import_run_id [FK `DEFERRABLE INITIALLY DEFERRED`], job_id, client_id, service_date, original/adjusted start time, adjustment_minutes, kept_original_time) + RLS (owner/admin/manager only). `import_maids_data` RPC updated (same signature) to persist the two new job columns and write `maids_import_duplicates` rows for same-time duplicate groups; return jsonb gains `duplicates_detected`/`duplicates`.
- **087** — Maids CSV importer (§8aa). `jobs` gains `scheduled_start_time`/`scheduled_end_time` (time), `balance_due`, `actual_minutes`, `cancellation_type` (CHECK'd `company_closure`/`client_initiated`), `team_code_raw`, `is_multi_visit_day`, and a partial unique index `(business_id, client_id, date, scheduled_start_time)` (the upsert dedup key). `clients` gains `first_service_date`, `historical_cancellation_count`, `historical_completion_count`, `team_performance` (jsonb), `current_price`, `tags text[]`, `review_flags text[]` (both GIN-indexed). New `import_runs` table + RLS (owner/admin/manager only). New `import_maids_data(p_business_id, p_mode, p_csv_types, p_clients_update, p_clients_create, p_jobs)` RPC, `SECURITY INVOKER` — one transaction covering optional job wipe, client upsert, job upsert (dedup on the new unique index), an untouched-client `review_flags` sweep, and a full derived-stat recompute over every client with jobs on file.
- **086** — Structured "Day off" categories (§8p). Adds `daily_assignments.status_type` (5 allowed values, CHECK'd to only apply when `team='OFF'`) and `notes text`. Also fixes `created_by` — column existed since the table's original migration but was never populated by any INSERT path (0 of 352 rows had it); added `DEFAULT auth.uid()`.
- **085** — `daily_assignments_active_unique`: unique index on `(business_id, date, employee_id) WHERE deleted_at IS NULL`, closing a gap between `PentaAssignments.assign()`'s own code comment (claimed this constraint already existed) and the actual schema (it didn't — only a PK + FKs). Part of the Schedule tab team-assignment save-bug fix (§8n); no duplicates existed in production, this is defense-in-depth against a race two near-simultaneous `assign()` calls could otherwise create.
- **084** — `resolve_job_from_gps_stop` (originally 075, most recently 079) re-tiered by distance alone: `high` (≤200ft, scheduled job), `medium` (≤200ft, unscheduled — previously impossible to match at all), `low` (200-400ft buffer, scheduled or not), `none` (>400ft). Outer search radius widened from 61m to 121.92m (400ft) so `low` is reachable. Fixes Live Tracking mislabeling real-but-unscheduled client visits as "possible lunch/break" (§8m). `poll-geotab-clocks` (only current caller) updated in the same change to gate clock-in/out writes to `confidence IN ('high','medium')` explicitly so the wider radius doesn't loosen payroll-clock accuracy.
- **083** — Fixes `get_team_device`/`get_team_device_for_poll` (migration 080/081) filtering the `'__default__'` sentinel out in the same `WHERE` clause used for `ORDER BY effective_from DESC LIMIT 1` — when the *most recent* row for a team was the sentinel (a manager picked "Default" to clear an override), that row was invisible to the ranking, so an *older* row with a real `device_id` won instead. Symptom looked exactly like a failed save: pick Default, save successfully, reopen, see the stale pre-override assignment. Rewritten as a CTE that ranks ALL rows first (including the sentinel) and only filters the single winner afterward. Also closes a grant gap found while re-verifying: `get_team_device` had never had an explicit `REVOKE ALL FROM PUBLIC` (every other function in this project does); not exploitable since RLS already blocks anon, but inconsistent with the established pattern.
- **082** — Full Geotab device visibility + editable nicknames + tenant-wide hide. `business_geotab_devices` (`business_id, geotab_device_id, display_name, hidden, first_seen_at, last_seen_at`, `UNIQUE(business_id, geotab_device_id)`) — populated automatically by `poll-geotab-clocks` (`upsert_geotab_device_seen`, `SECURITY DEFINER`/`service_role`-only) on every `Get Device` fetch, not user-created. Read-only RLS for any authenticated tenant member (Live Tracking needs it, not just managers); all writes are RPC-only (`rename_geotab_device`, `set_geotab_device_hidden`), both `SECURITY DEFINER` and — since they're browser-facing with an attacker-controlled `p_business_id` — resolve the caller's own `business_id`/role from `users` and compare, rather than trusting the parameter (mirrors `set_job_actual_time`, migration 032). `device_name_history` is an insert-only audit trail (`old_name, new_name, changed_by, changed_at` via `clock_timestamp()`, `reason`), written exclusively by `rename_geotab_device`, manager-tier `SELECT` only. Renaming a device only changes what Penta displays — Geotab's native name is untouched, and `poll_geotab_runs`/`gps_match_log` keep logging the raw `geotab_device_id` for debugging.
- **081** — `poll_geotab_runs` gains `device_assignment_resolved`/`device_name_matched` counters (how many team-polls per run used an explicit override vs. the name-matching fallback) + `get_team_device_for_poll(business_id, team_code, on_date)`: a `SECURITY DEFINER`, `service_role`-only twin of migration 080's `get_team_device`. Needed because `poll-geotab-clocks` runs as `service_role`, which has no table grant on `team_device_assignments` (this project's `service_role` is not `BYPASSRLS` — see `[Service_role_has_no_table_grants]` below) — the `SECURITY INVOKER` browser-facing function 42501s if called from the EF.
- **080** — Device-to-team assignment override, per-tenant, day-scoped. `team_device_assignments` (`business_id, team_code, device_id, effective_from, effective_to, notes`, `UNIQUE(business_id, team_code, effective_from)`) + RLS (same-tenant SELECT, manager-tier INSERT/UPDATE, no DELETE policy — history stays intact) + `get_team_device(business_id, team_code, on_date)` (`SECURITY INVOKER`, `authenticated`-only — RLS is the tenant boundary). Fixes the operational problem where Geotab device names are hardcoded to physical vehicles (device "B1" = the B1 van): when a vehicle is lent out or swapped, the existing `device.name.toUpperCase().includes(teamCode)` matching (`index.html`, ~6 call sites, `poll-geotab-clocks`) silently misattributes GPS data to the wrong team, or finds nothing. `get_team_device` implements ONLY the explicit-assignment lookup — it can't also do the name-matching fallback in SQL (no `devices` table; Geotab's device list only exists as live API data the caller already holds via an authenticated session) — callers treat a zero-row result as "no override, fall back to name-matching," which is why the function is `RETURNS TABLE` rather than a scalar (a scalar can't distinguish "no assignment row" from "an explicit no-GPS assignment," both of which would otherwise collapse to the same NULL). The Team Management UI writes a `'__default__'` sentinel `device_id` when a manager explicitly picks "Default" from the dropdown — there's no DELETE policy, so "revert to default" can't be represented by removing the row; the resolver filters `'__default__'` out (`IS DISTINCT FROM`), making it behave exactly like "no row exists" everywhere. Backfilled for Manna's 8 teams from the *live* Geotab device list (not assumed) — B1 had zero matching device at backfill time, seeded as an explicit `device_id = NULL` row.
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
- **067** — `business_geotab_integrations` table (one row per tenant, server / database / username / password / status / last_used_at / last_error) + RLS owner+admin only + 4 SECURITY DEFINER RPCs (`get_active_geotab_integration` for service-role EF, `get_geotab_summary` for any authenticated tenant member, `mark_geotab_integration_used`, `mark_geotab_integration_error`). PR1 of Geotab strategy split. Browser's hardcoded GEOTAB_USER/PASS/DB constants at index.html ~27401 are untouched by PR1 — Manna's production fleet tracking still uses the in-bundle credentials. PR2 will rewire all 8+ `geotabCall(...)` sites through the new `geotab-call` Edge Function and retire the constants. The Geotab session pivot (`my.geotab.com` → `myXX.geotab.com` returned from auth as `result.path`) is handled server-side in the EF's session cache.
- **066** — Split-pattern rate-limit RPCs: `rate_limit_check(key, max, window_seconds)` (read-only) + `rate_limit_increment(key, window_seconds)` (bump-only). Replaces the atomic check-and-increment pattern for the SMS Edge Functions so failed calls don't consume budget (RC token expired, recipient gate, etc.). The old atomic `check_rate_limit` + `check_rate_limit_dual` stay in place — claire-chat still uses the atomic single. Per-EF rate-limit matrix:

  | Edge Function | Key                                      | Limit       | Increment fires on |
  |---------------|------------------------------------------|-------------|--------------------|
  | send-sms      | `user:<auth_uid>:send-sms`               | 100/hr      | RC 200 OK          |
  | send-sms      | `tenant:<business_id>:sms_all`           | 500/hr      | RC 200 OK          |
  | rc-inbox      | `user:<auth_uid>:rc-inbox`               | 60/hr       | success (incl. mid-pagination 429) |
  | rc-mark-read  | `user:<auth_uid>:rc-mark-read`           | 300/hr      | RC 200 OK          |
  | get-weather   | `user:<auth_uid>:get-weather`            | 60/hr       | upstream 200 OK (cache hits skip) |
  | claire-chat   | `claire-chat:<auth_uid>` (atomic)        | 300/hr      | up-front atomic    |

  Race trade-off: the split pattern allows N concurrent requests at count=max-1 to all pass the check before any increments. At these limits and typical user behavior (a manager isn't firing 10+ parallel calls) the overshoot is bounded and acceptable. claire-chat's atomic RPC has no overshoot but penalizes failures.
- **065** — `business_offices.is_primary boolean` + backfill (oldest active office per tenant) + partial unique index `(business_id) WHERE is_primary AND NOT deleted`. The weather widget's `_resolveWeatherCoords()` prefers the primary row over `rows[0]`, fixing the indeterminism that surfaced for multi-office tenants. Admin → Offices & Depots gets a "Set primary" button that runs a two-step UPDATE (clear old → set new) to keep within the unique index. Same PR moves the localStorage forecast cache key from `weather_cache_v1` to `weather_cache_v1_<bid>` so signing out of one tenant and into another in the same browser doesn't replay the previous tenant's forecast.
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
