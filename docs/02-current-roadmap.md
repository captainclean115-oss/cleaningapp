# Penta — Current Roadmap

This document tracks what's being built now, what's next, and what's deferred. Update this when priorities shift.

## Active Priorities (next 60-90 days)

### Priority 1: Maids Sync Report (Phase 1)

**Why:** Required before first paying Maids franchisee onboards. Makes the mirror-with-report compliance framework actually work in practice.

**Build duration:** 1-2 weeks

**What it does:**
- Daily report generated end-of-business-day
- Shows: new clients added today, schedule changes today, time entries today, client deletions
- Visual checklist format optimized for fast Maids data entry
- Audit log: when report generated, when franchisee marked synced, time elapsed
- Visible "Maids Sync Status" indicator on dashboard (green/yellow/red)
- Daily nudge if previous day's sync hasn't been completed

**Important:**
- Franchisee is the actor entering data (legal cleanness)
- No automated access to Maids' system
- Build architecture so future browser extension can replace manual step without changing data flow

### Priority 2: Financial Intelligence Layer (Beginner Tier Foundation)

**Why:** Tom needs this for Manna Maids himself. Becomes the wedge feature for early customer acquisition. Replaces bookkeeping cost for customers (real value capture).

**Build duration:** 4-8 weeks for full Phase 1

**Components:**
- Plaid integration (with manual entry fallback)
- Auto-categorized transaction layer
- Basic P&L (revenue, expenses by category, net)
- Year-over-year revenue trend
- Top expense categories and trends
- "Are you profitable" answer (yes/no with margin)
- Basic CPA-ready year-end export

**Important:**
- Plaid must be optional, not mandatory
- Manual entry fallback always available
- Operators wary of bank integration get useful features without Plaid
- Plaid as upgrade unlocks real-time accuracy

### Priority 3: Testing Infrastructure

**Why:** Tom currently spends ~80% of build time on bug-finding and bug-fixing. Automated testing dramatically compresses this loop.

**Build duration:** 2-4 weeks

**Components:**
- Playwright end-to-end tests for major workflows
- Unit tests for critical functions
- Tests run automatically on every code change (GitHub Actions)
- Each new feature ships with tests written alongside
- Tests must pass before features declared complete

**Workflow change:**
- Claude Code writes tests for every feature
- Claude Code runs tests before declaring done
- Failures get fixed and re-tested in same session
- Tom verifies behavior, not mechanics

## Recently Shipped

### v11.0.0 — Multi-tenant hardening (2026-05-11)

Foundational push to make Penta production-safe for a second paying tenant. Four items in sequence, each tested before the next:

- **Item 1 — Replace hardcoded `BUSINESS_ID` with auth-resolved tenant.** New `window.PentaTenant` module declared at the very top of the script. Boot router fetches `business_id` in the same round-trip as role + perms, calls `PentaTenant._set` before routing fires. PentaClients reads `_bizId()` (throws if unresolved — fail-loud). Hydrate gates through `PentaTenant.ready()`. `renderApplicantsList` and the static home-greeting both unbound from Manna Maids.
- **Item 2 — INSERT WITH CHECK audit (Migration 036).** 96 tenant-scoped tables inspected; 95 already gated via `auth_belongs_to_business(business_id)`; 9 additionally role-gated. One real gap: `job_applications_public_insert` had `WITH CHECK true` on `anon`. Tightened to require `business_id` references a real non-deleted business.
- **Item 3 — Application form tenant resolution (Migration 037).** Added `businesses.slug` + UNIQUE index + backfill for the 4 existing tenants. New `get_business_by_slug(slug)` returning `(id, name)` and `submit_job_application(slug, payload)` SECURITY DEFINER RPCs. Browser no longer sends `business_id` for public applicants — the RPC resolves slug → tenant server-side. Form auto-opens when `?biz=<slug>` is in the URL. Manager-side share-link surface with Copy button at the top of the Applicants tab. `REVOKE INSERT ON job_applications FROM anon` to close the direct path.
- **Item 4 — RLS audit on 9 non-business_id tables (Migration 038).** 6 already FK-joined to business_id-bearing parents; 3 catalog (vendors / products / vendor_products) intentionally global; 1 (`aggregation_snapshots`) had role=PUBLIC tightened to `authenticated`. No accidentally unscoped tables remained.

Verified end-to-end against the Manna Maids Test and Test Business Two tenants — slug resolution returns correct ids, submit RPC writes applications to the right tenant, hardened policy rejects unknown business_ids. Manna Maids stayed on stable code during the work via the `feat/multi-tenant-hardening` branch.

**Surfaced but not fixed (separate post-PR sweep):** "Manna Maids" / "MannaMaids" string literals remain in 18 places — handbook H1s, social caption hashtags, Claire system prompt, SMS templates, weekly hours report header, mailto subject, On-My-Way SMS, reward catalog hoodie name. Tom's RingCentral primary (`15085598062`) hardcoded in 2 places. "in Massachusetts (8 teams, ~330 clients)" baked into the Claire system prompt. "— Tom" sign-off on 2 outgoing SMS templates. Resolution path: replace with reads from `businesses.name` + `business_phone_numbers` + per-tenant onboarding fields.

**Explicitly deferred:** Claire's Anthropic API calls still run direct-from-browser with the key in localStorage. This is a budget security risk (key leak = quota drain), not a tenant isolation risk (RLS still scopes Claire's inputs). Migrating Claire behind an Edge Function is scheduled as a separate focused block.

### Sprint 11.5 — Rewards system v1 (manual loop)

Done as of 2026-05-10. PentaRewards facade + Supabase-backed rewards schema (Migration 027), peer-to-peer gifting (Migration 029), teammate display RPC (Migration 030). Three UI surfaces: Manager Rewards (Leaderboard/Queue/Grant/Settings/Ledger) for approval+grant workflow, EmpRewards employee UI (balance+rank, submit photo, send gift, redeem, leaderboard, recent activity), and the legacy localStorage demo retired to thin delegates. Auto-rewards (rules engine: clock-in attendance, 5-star reviews, referrals, etc.) deferred to Sprint 11.6 Phase 2.

## Mid-Term (3-6 months)

### Sprint 11.6 — Auto-rewards (rules engine)

The Phase 2 follow-up to Sprint 11.5. Earn events fire automatically from operational signals: clock-in for perfect-attendance bonuses, 5-star client reviews, referral conversions, birthdays/anniversaries, profitable-job bonuses. DB triggers or Edge Functions watch operational tables and write ledger rows when conditions hit. Manager Rewards Settings grows a "Rules" tab to define triggers (event → award amount). Not started; scoped after the three top-priority items above.

### AI Quote with Margin Selection (Standard Tier)

- Phase A: Basic profit-aware quote generation with manual cost entry, 15/20/25% margin options
- Phase B: Smart job parameter capture, photo-based estimation, historical Penta data informs predictions
- Phase C: Claire-integrated quoting via voice or text command

### Per-Client Profitability View (Standard Tier)

Real-time profitability per client. Surface on client card. "Sarah Henderson: 18-month customer, 47 cleans, $4,235 revenue, $3,118 cost, $1,117 profit, 26% margin."

### Anomaly Detection on Costs (Standard Tier)

"Your supply spend was $1,847 this month versus $1,200 average. Top driver: 3 unusually large purchases at Costco."

### Quarterly Pricing Recommendations (Standard Tier)

Claire surfaces under-margin clients quarterly with drafted price increase notices.

## Longer-Term (6-12 months)

### Cash Flow Forecasting (Premium Tier)

CFO-level cash flow visibility for operators who don't have a CFO.

### Margin-Aware Scheduling (Premium Tier)

Claire's schedule reassignment factors in margin. Operations decisions become profit-aware.

### Apple Watch Field Tool

Native watchOS app for team leaders, 4-8 weeks alongside native iOS transition.

### Native iOS Transition

PWA → native, with watchOS in parallel.

### Maids Sync Browser Extension (Phase 2)

Triggered at 15+ paying Maids franchisees. Removes manual copy-paste friction. 4-8 weeks plus Chrome Web Store approval.

## 2027+

### Voice AI Receptionist (Phase C, Full Stack Tier)

The big one. AI voice receptionist powered by Claire. 24/7 inbound call handling with quoting, booking, account questions, schedule changes. Concurrent call handling unlimited per customer.

### Vertical Expansion

Decision deferred to mid-2027 with 50-100 customers providing data on whether to stay cleaning-deep or expand to adjacent verticals.

### Claire Customization Architecture

Three-layer admin board for operators to customize Claire's behavior, capabilities, and instructions.

## Deferred / Not Now

### Build Voice Internally

Use ElevenLabs for TTS. Architecturally keep provider swappable. Revisit self-hosting at 100,000+ minutes/month scale (probably 2028+).

### General Browser Automation Platform

2027+ consideration as platform expansion. Premature for current stage.

### Autonomous AI Agent for Building

Stay with Tom + Claude Code workflow. AI agents not yet good enough at strategic judgment to replace Tom in the loop. Revisit as agent capabilities mature.

### Submitting Penta for Formal TMI Approval

Don't do it now. Wait for 12-18 months and 30+ Maids franchisees on Penta with outcome data. Then ask with leverage.

## Capacity Planning

- 5 paying customers: manageable for Tom solo
- 15 paying customers: hard
- 20 paying customers: trigger first hire (Customer Success role)
- Hiring sequence: customer success first, sales/BD second, ops/admin third, engineering LAST

## Decision Log (recent significant decisions)

- May 5, 2026: Maids CEO/COO meeting, strong validation, no immediate deal, board invitation pending response
- May 6, 2026: 5-6 Maids franchisees expressing organic interest in Penta
- May 7, 2026: Mirror-with-report compliance framework locked, Maids Sync Report prioritized
- May 10, 2026: Sprint 11.5 manual rewards loop shipped to main (v10.5.0). Auto-rewards rules engine deferred to Sprint 11.6 Phase 2.
- May 11, 2026: v11.0.0 multi-tenant hardening (4-item push) shipped on `feat/multi-tenant-hardening`. Penta is production-safe for a second paying tenant. Claire Edge Function migration explicitly deferred — acceptable because Claire's current architecture is a budget security risk, not a tenant isolation risk.
- Pricing tier structure locked: $149/$349/$599-799/$1,499 (with voice usage overage)
- Voice receptionist locked as Full Stack tier driver
- Financial intelligence layer foundational (not premium add-on)
- Don't use ElevenLabs Conversational AI bundle — keep architecture decoupled
