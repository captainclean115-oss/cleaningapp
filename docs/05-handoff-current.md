# Penta — Current Strategic Context (May 2026)

This document captures the most recent strategic state. Update this as significant changes happen.

## Recent Major Events

### May 10, 2026: Sprint 11.5 Rewards Loop Shipped (v10.5.0)

End-to-end manual rewards system landed on `main`. Employees can submit photos for approval, gift points peer-to-peer (with caps), redeem from a configurable catalog. Managers approve/reject submissions, fulfill/reject redemptions, grant points manually, and configure earn-events + catalog items. Real-time across all surfaces.

**Technical highlights:**
- PentaRewards facade (Supabase-backed; Migrations 027 + 029).
- Migration 030 — `get_business_teammates()` RPC (SECURITY DEFINER) bypasses RLS for safe display columns only, so employee-side leaderboard / gift picker render real names.
- PentaClients now exposes `uuid` (real Supabase id) alongside legacy `id` (external_id) for FK references.
- Self-resolver pattern in EmpRewards: 3-tier resolution (cache → auth.uid()+PentaEmployees → legacy currentEmployee, UUID-gated) fixes the `e_*` demo-shape leakage that was breaking storage RLS.

**What's next on rewards:** auto-rewards rules engine (Sprint 11.6 Phase 2) — defer until after Maids Sync Report Phase 1, Financial Intelligence Phase 1, and testing infrastructure ship.

### May 5, 2026: Maids Corporate Meeting

Maids CEO and COO visited Tom's office. 4-5 hour meeting. Strong validation outcome but no immediate deal.

**What they said:**
- They knew about Penta before arriving
- Loved it, said forward-thinking
- Specifically called out Tesla integration as forward-thinking
- Told Tom Penta would be "great for independent operators"
- When Tom proposed Penta as add-on to Water Street: "That's where my head is thinking"
- Invited Tom to their software development advisory board (response pending — defer)
- Said Tom can't fully operate Manna Maids on Penta only (must keep Water Street as system of record)

**Constraints they articulated:**
- Franchisor needs network-level data access (capability Penta could build but couldn't visualize)
- Already chose Water Street as vendor, in active rollout, switching doesn't make sense
- No proof of concept yet from Penta

### May 6-7, 2026: Organic Maids Franchisee Adoption

Day after corporate meeting, Tom started talking with other Maids franchisees. The strategic picture shifted meaningfully.

**What franchisees told Tom:**
- Not a single Maids owner is happy with current systems
- Network is 10+ years behind in technology
- Multiple owners independently arrived at same framework: "as long as you keep the Maids site updated, we can use Penta"
- They view Penta as additive, not threatening
- 5-6 Maids owners now want to use Penta
- One owner had multi-hour conversation with Tom and confirmed framework
- Another said Penta is everything Maids owners need

**Strategic implication:** Adoption is happening organically without needing a corporate deal. Proof of concept will come from inside the network, not outside it.

## Current Compliance Framework

### Mirror-with-Report Framework (Locked)

For Maids franchisees who use Penta:
- Penta runs alongside The Maids' required system, not as a replacement
- All data in Penta gets mirrored to Maids' system via daily report
- Franchisee enters data into Maids' system (legal cleanness)
- Maids Sync Report feature (Phase 1) makes this practical
- Audit log tracks compliance status

### Why This Works

The Maids' system only has 5 capabilities (new clients, delete clients, scheduling, time in, time out). Mirror burden is minimal. Penta is positioned as "added tool like QuickBooks or RingCentral" — every Maids franchisee uses many tools TMI hasn't formally approved without consequence.

### Risk Assessment

**Probability of TMI enforcement against Tom in next 12 months: 5-10%**

Risk-decreasing factors:
- 1,000-employee Maids commercial cleaning operation tolerated openly by CEO
- TMI's enforcement culture is permissive in practice for high-performing franchisees
- Penta isn't competing with Maids Business as a service operation
- Mirror framework keeps required data current
- Top-margin franchisee status

Risk-increasing actions to avoid:
- Public marketing of Penta to other Maids franchisees
- Press positioning Penta as Maids-killer or Water Street competitor
- Attending Maids National Convention to pitch Penta
- Anything that makes corporate look bad to other franchisees

## Active Customer Pipeline

- **Manna Maids** (Tom): Active operational user, daily
- **5-6 Maids franchisees**: Expressing interest, in evaluation conversations
- **X.com warm leads**: Riley O'Hara, SMBMoneyMike, Jeramie Irwin, Ivan Nikolaev
- **Independent operators**: Identified as parallel acquisition path

**Target for first 50 customers:** 60% Maids franchisees / 40% non-Maids (independent operators + adjacent verticals)

## Pricing Strategy (Locked)

### Tier Structure

- **Beginner $149**: operations basics + Plaid financial visibility + basic P&L
- **Standard $349**: + AI Quote with margin selection + per-client profitability + Claire coaching
- **Premium $599-799**: + cash flow forecasting + margin-aware scheduling + Apple Watch
- **Full Stack $1,499 base + voice usage**: + AI voice receptionist + multi-location
  - Includes 500 voice minutes/month
  - Overage at $0.75/minute

### Design Partner Pricing for First Customers

- First 5 customers: $99-149/month for 6 months in exchange for case studies, testimonials, feedback
- Customers 6-15: $199-249/month
- Customers 16+: full standard pricing

## Competitive Positioning (Locked)

Penta is NOT positioned as "first AI-native field service platform" — that's taken by QuoteIQ and FieldCamp.

Penta IS positioned as:
- Deepest residential cleaning operations platform with operator-built insight
- Multi-vertical platform (cleaning is one of several verticals)
- Operator-credibility advantage over horizontal SaaS founders
- Three-tier voice AI distinction: Penta is reasoning AI, not scripted AI

### Sales Pitch Languages

**vs QuoteIQ:** "QuoteIQ is great for basics across many industries. Penta is what you buy when you want to actually run a residential cleaning operation at the highest level."

**Voice AI differentiation:** "Most AI voice tools are scripts dressed up as AI. The voice sounds natural but the brain follows decision trees. Claire is different because she's the same AI that runs the rest of Penta's operations. She knows your pricing, your schedule, your team, your client history. When someone calls, she's not following a script — she's reasoning through the conversation using actual business context."

**Concurrent calls:** "Penta's voice receptionist handles every call simultaneously. Five at once, fifty at once — every caller gets immediate attention. No hold queues. No voicemail. No missed leads during peak hours."

## Pending Strategic Decisions

- Board invitation response (defer, scope carefully when responding)
- Franchise attorney consultation (recommended, $400-800, in next 2-4 weeks)
- First customer success hire timing (trigger at 15-20 paying customers)
- Conference attendance plan (ISSA Show, ARCSI for late 2026/2027)

## Updated Valuation Framework

Without immediate Maids network deal:
- 12 months out: 30-50 customers
- 24 months out: 150-250 customers
- 36 months out: 500-1,000 customers
- End 2030: ~$20-50M ARR
- End 2030 valuation: $400M-$1.2B
- Tom's 80-90% ownership = $320M-$1B personal outcome

Probability distribution:
- $5B+ outcome: 5-10%
- $1-3B outcome: 20-30%
- $300M-$1B outcome (base case): 30-40%
- $50-300M outcome: 25-35%
- Below $50M / failure: 15-25%

## Most Recent Workflow Decision

Tom and Claude switching to new workflow:
- Strategic conversations stay in Claude.ai project
- Build/test/fix work moves entirely to Claude Code
- Documentation moves to /docs folder in code repository
- Each Claude Code session reads /docs at start to get full context
- Bug-fixing happens in Claude Code, not Claude.ai (no more copy-paste between)

This document is part of that new workflow. Future updates happen here as strategic context evolves.
