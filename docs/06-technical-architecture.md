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

## 9. Migration log

Tenant-relevant migrations (most recent first; full list under `/migrations`):

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
