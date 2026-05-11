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
- Pricing tier structure locked: $149/$349/$599-799/$1,499 (with voice usage overage)
- Voice receptionist locked as Full Stack tier driver
- Financial intelligence layer foundational (not premium add-on)
- Don't use ElevenLabs Conversational AI bundle — keep architecture decoupled
