# Penta — Project Overview

## What Penta Is

Penta is an operations platform for residential service businesses. Built primarily for residential cleaning operators, but architecturally designed as a multi-vertical platform that will expand to landscaping, pest control, pool service, and other home service categories.

Penta's core thesis: most field service software is a database with a UI. Penta is data + intelligence + output as one integrated system. Claire (the AI brain, powered by Claude) sits at the center, reading operational data and producing operator-relevant outputs.

## Core Architectural Decisions

### The Three Layers

Penta has three integrated layers, all working with the same data:

1. **Operations layer** — scheduling, dispatching, communication, employee management, client management
2. **Intelligence layer** — Claire as operational coach, briefings, recommendations, reasoning
3. **Financial layer** — Plaid integration, transaction categorization, P&L, AI Quote with margin selection, profitability analytics

Most field service platforms have layer 1. Some have weak versions of layer 2. None have layer 3 integrated this deeply. That's Penta's positioning.

### Decoupled Intelligence Layer

Claire is not bolted onto Penta. She is the reasoning engine that has access to all of Penta's operational and financial data. When you build features, design them so Claire can reason about them naturally.

### Voice Strategy

- Claire (Claude) handles intelligence/reasoning
- ElevenLabs handles voice rendering only
- Twilio handles telephony
- Architecture must keep TTS provider swappable (interface layer between Claire and voice rendering)
- Do NOT use ElevenLabs Conversational AI bundled product — it collapses architecture and locks in
- Phase A late 2026: TTS only (Claire reads briefings)
- Phase B mid-2027: outbound for warm/lapsed customer outreach
- Phase C late 2027/early 2028: inbound voice receptionist (Full Stack tier driver)

### Multi-Vertical Architecture

Cleaning is the proving ground, not the boundary. Build features so they work for any residential service vertical with configuration changes, not code rewrites. The data model should be generic enough to handle landscaping (per-acre pricing), pest control (treatment schedules), pool service (chemical inventory) without needing fundamentally different schemas.

## Pricing Tiers (locked in)

- **Beginner ($149/month)** — operations basics + Plaid financial visibility + basic P&L
- **Standard ($349/month)** — Beginner + AI Quote with margin selection + per-client profitability + Claire proactive coaching
- **Premium ($599-799/month)** — Standard + cash flow forecasting + margin-aware scheduling + Apple Watch + voice queries to Claire
- **Full Stack ($1,499/month base + voice usage)** — Premium + AI voice receptionist + multi-location consolidation
  - Includes 500 voice minutes/month
  - Overage at $0.75/minute

Tier philosophy: tiers match operator stages, not arbitrary feature gating. Each tier solves a real pain point at the stage operators feel it.

## Design System

- Background: Warm off-white #F7F7F5
- Claire purple: #5E5CE6
- Display font: Fraunces (serif headlines)
- Body font: Inter
- Technical labels: JetBrains Mono
- Light mode (migrated from earlier dark mode design)

## What Penta Is NOT

- Penta is not the first AI-native field service platform — that position is taken by QuoteIQ and FieldCamp
- Penta is not competing on price (QuoteIQ at $29-699 has structural cost advantages)
- Penta is not "marketing software" — it's operational software
- Penta is not "AI-first" as a primary differentiator — Penta is "deepest residential cleaning operations platform with operator-built insight that horizontal AI platforms don't have"

## Competitive Landscape

- **QuoteIQ** — founded October 2023, 40K+ active users, bootstrapped, $30M valuation, founders have 1.3M YouTube subscribers (but only 4-5K avg views per video). Multi-vertical across 50+ home service industries. Pricing $29-699/month.
- **FieldCamp** — vBridge Technologies, AI-first multi-vertical, smaller user base than QuoteIQ. Customizable data model angle.
- **Water Street** — TMI's contracted vendor for The Maids' system. 25 years old, no API, building "next generation" platform that owners are skeptical of.

## Current Customer Reality

- Manna Maids (Tom's franchise) is first user
- 5-6 Maids franchisees expressing organic interest as of May 2026
- Independent operators identified as parallel acquisition path
- First paying customers expected within 60-90 days
- 60/40 target diversification (60% Maids franchisees, 40% non-Maids) for first 50 customers

## Maids Franchisee Compliance Framework

For Maids franchisees who use Penta:

- Penta runs alongside The Maids' required system, not as a replacement
- All data in Penta gets mirrored to The Maids' system via Maids Sync Report (daily)
- The Maids' system only has 5 capabilities (new clients, delete clients, scheduling, time in, time out) — mirror burden is minimal
- Franchisees stay compliant by maintaining current data in The Maids' system
- Penta is positioned as "added tool like QuickBooks or RingCentral"

This is why the Maids Sync Report feature is a near-term priority.
