// Edge Function: score-client-health
//
// Computes a 0-100 health score for every active client of a business and
// records the run via public.record_client_health_run (migration 071).
//
// ─── Why the factor set looks the way it does ──────────────────────
//
// A signal inventory against live data killed every behavioral signal
// the original Phase A scope assumed:
//
//   jobs.status          1916 of 1927 PAST jobs are still 'scheduled'.
//                        Only 4 'completed' rows exist, ever. The app
//                        never transitions job status, so completion
//                        rate is ~0.2% for every client alike.
//   cancellations        7 rows total across 346 clients.
//   incidents            2 rows.  job_issues: 3 rows.
//   messages/convos      0 rows — client SMS never landed in Postgres.
//   clients.balance      1 client nonzero.
//   avg_net_rev_per_job  0 populated.
//
// And one active trap: last_service_date / next_service_date LOOK like
// ideal inputs but are stale CRM imports (all 327 last_service_date
// values >90 days old; EVERY next_service_date in the past). Scoring
// off them renders all 327 clients as churning. They are not read here.
//
// What is live is the jobs table and clients.frequency, plus SMS pulled
// from RingCentral at score time. Hence: cadence adherence, revenue
// trend, forward booking, SMS tone. The dead behavioral factors are
// still written into the factors jsonb at weight 0 so the shape is
// stable and they can be switched on without a migration.
//
// ─── Why ONE rc-inbox call, not one per client ─────────────────────
//
// rc-inbox has no per-phone-number filter — it pulls the tenant's whole
// SMS inbox for a date window. It is also rate-limited (60/hr per user,
// 120/hr per business). Calling it per client would blow the budget at
// client #60 and never finish a run. So: one call per run, bucket the
// messages by normalized last-10-digit phone, match to clients in
// memory. 1 call instead of 327.
//
// Raw message bodies are held in memory for the duration of the run and
// discarded — nothing is persisted. Only the derived 0..1 tone value and
// a short rationale reach the database.
//
// Deploy:
//   supabase functions deploy score-client-health --project-ref wymoezilyjmyibmuqqmr
//
// Required secrets: ANTHROPIC_API_KEY (shared with claire-chat).
//
// Request:  POST { business_id?, dry_run? }
//   business_id  required for service-role callers; ignored for user
//                JWTs (resolved from the caller's user row instead).
//   dry_run      compute and return scores without writing a run.
//
// Response: { run_id, scored, skipped, band_counts, sms: {...}, scores? }

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY") || "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY env var");
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
if (!ANTHROPIC_KEY) {
  console.warn("[score-client-health] ANTHROPIC_API_KEY not set — sms_tone will be null for every client");
}

const ANTHROPIC_VERSION = "2023-06-01";
// Opus 5. Tone read on a short SMS thread is a classification task, so
// it runs at low effort — the judgment is easy, the volume is what costs.
const MODEL  = "claude-opus-5";
const EFFORT = "low";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Config ────────────────────────────────────────────────────────

interface HealthConfig {
  enabled: boolean;
  weights: Record<string, number>;
  drop_threshold: number;
  sms_lookback_months: number;
}

const DEFAULT_CONFIG: HealthConfig = {
  enabled: true,
  weights: {
    cadence_adherence: 0.35,
    sms_tone:          0.25,
    revenue_trend:     0.20,
    forward_booking:   0.20,
    completion_rate:   0.0,
    cancel_rate:       0.0,
    incident_rate:     0.0,
  },
  drop_threshold: 15,
  sms_lookback_months: 3,
};

// clients.frequency is the frequency_code enum. frequency_days is the
// explicit override when a client is on a non-standard cadence.
const FREQUENCY_DAYS: Record<string, number> = {
  "RMS-WEK": 7,   // weekly
  "RMS-EOW": 14,  // every other week
  "RMS-ETW": 21,  // every third week
  "RMS-EFW": 28,  // every fourth week
  "RMS-MON": 30,  // monthly
  // OMS = one-time / on-demand — deliberately absent. A one-off client
  // has no cadence to adhere to, so cadence_adherence stays null and its
  // weight redistributes rather than scoring them as lapsed.
};

function expectedIntervalDays(c: ClientRow): number | null {
  if (typeof c.frequency_days === "number" && c.frequency_days > 0) return c.frequency_days;
  if (c.frequency && FREQUENCY_DAYS[c.frequency]) return FREQUENCY_DAYS[c.frequency];
  return null;
}

// ─── Types ─────────────────────────────────────────────────────────

interface ClientRow {
  id:                string;
  external_id:       string | null;
  first_name:        string;
  last_name:         string | null;
  phone:             string | null;
  additional_phones: string[] | null;
  frequency:         string | null;
  frequency_days:    number | null;
}

interface JobRow {
  client_id: string | null;
  date:      string;
  price:     number | null;
  status:    string;
}

interface ProjectedMessage {
  id:           string;
  direction:    "Inbound" | "Outbound";
  from:         { phoneNumber: string; name: string | null };
  to:           Array<{ phoneNumber: string; name: string | null }>;
  creationTime: string;
  subject:      string | null;
  body:         string | null;
  readStatus:   "Read" | "Unread";
}

interface Factor {
  weight: number;
  value:  number | null;
  detail: string;
}

// ─── Helpers ───────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// Client phones are stored dashed (NNN-NNN-NNNN); RingCentral returns
// E.164 (+1NNNNNNNNNN). Last 10 digits is the only stable join key.
function last10(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function bandFor(score: number): "healthy" | "watch" | "at_risk" {
  if (score >= 70) return "healthy";
  if (score >= 40) return "watch";
  return "at_risk";
}

// ─── Deterministic factors ─────────────────────────────────────────

// Cadence adherence: how well the client's actual service rhythm tracks
// their configured frequency. Two failure modes matter and they need
// different measurements:
//
//   1. Chronic drift — jobs consistently land later than the cadence.
//      Caught by the median gap between consecutive past jobs.
//   2. Sudden stop — a client who was perfectly regular and then simply
//      stopped. Their median gap still looks great, so only the trailing
//      gap (today minus their last job) catches it.
//
// Scoring the median alone would call a client who vanished 5 months ago
// "perfectly adherent". Take the worse of the two.
function cadenceAdherence(pastDates: Date[], expected: number | null, now: Date): Factor {
  if (expected === null) {
    return { weight: 0, value: null, detail: "no configured frequency (one-time client)" };
  }
  if (pastDates.length === 0) {
    return { weight: 0, value: null, detail: "no past jobs on record" };
  }

  const last = pastDates[pastDates.length - 1];
  const trailingGap = Math.max(0, daysBetween(last, now));
  const trailingScore = clamp01(1 - Math.max(0, trailingGap / expected - 1));

  if (pastDates.length === 1) {
    return {
      weight: 0,
      value: trailingScore,
      detail: `1 past job; ${trailingGap}d since last vs ${expected}d cadence`,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < pastDates.length; i++) {
    gaps.push(Math.max(0, daysBetween(pastDates[i - 1], pastDates[i])));
  }
  const med = median(gaps);
  const medScore = clamp01(1 - Math.max(0, med / expected - 1));

  const value = Math.min(medScore, trailingScore);
  return {
    weight: 0,
    value,
    detail: `median gap ${med.toFixed(0)}d vs ${expected}d cadence; ${trailingGap}d since last job`,
  };
}

// Revenue trend: trailing 90 days of billed work against the 90 before
// it. Ratio >= 1 is full marks — growth beyond flat isn't extra credit,
// because the signal we care about is decline.
function revenueTrend(past: JobRow[], now: Date): Factor {
  const cut90  = new Date(now.getTime() - 90 * DAY_MS);
  const cut180 = new Date(now.getTime() - 180 * DAY_MS);

  let recent = 0;
  let prior  = 0;
  for (const j of past) {
    const d = new Date(j.date + "T00:00:00Z");
    const p = typeof j.price === "number" ? j.price : 0;
    if (d >= cut90) recent += p;
    else if (d >= cut180) prior += p;
  }

  if (recent === 0 && prior === 0) {
    return { weight: 0, value: null, detail: "no billed work in the last 180d" };
  }
  if (prior === 0) {
    return { weight: 0, value: 1, detail: `$${recent.toFixed(0)} in last 90d, none in the prior 90d (new or resumed)` };
  }
  const ratio = recent / prior;
  return {
    weight: 0,
    value: clamp01(ratio),
    detail: `$${recent.toFixed(0)} last 90d vs $${prior.toFixed(0)} prior 90d (${(ratio * 100).toFixed(0)}%)`,
  };
}

// Forward booking: is there work on the calendar, and is it soon enough
// to be consistent with the client's cadence?
//
// An empty calendar is only evidence of churn for a client we can see is
// RECURRING and ACTIVE. Two cases where it is not, and both were real
// false positives on live data before this guard existed:
//
//   - One-time (OMS) clients. They have no cadence, so "nothing booked"
//     is their normal steady state, not a warning.
//   - Clients with no service history in the window at all. Without a
//     past job to corroborate, forward_booking would be their ONLY
//     non-null factor, and a lone unsupported 0 would take the whole
//     composite to 0/100 — flagging 13 clients as maximally at-risk on
//     the strength of one signal with nothing behind it.
//
// In both cases return null so the weight redistributes, rather than 0.
// A recurring client WITH history and an empty calendar is still a real
// 0 — that is the signal this factor exists to catch.
function forwardBooking(
  futureDates: Date[],
  expected: number | null,
  pastJobCount: number,
  now: Date,
): Factor {
  if (futureDates.length === 0) {
    if (expected === null) {
      return { weight: 0, value: null, detail: "one-time client with nothing booked (no recurring cadence)" };
    }
    if (pastJobCount === 0) {
      return { weight: 0, value: null, detail: "no service history in the window to judge an empty calendar against" };
    }
    return { weight: 0, value: 0, detail: "no future jobs booked" };
  }
  const next = futureDates[0];
  const daysOut = Math.max(0, daysBetween(now, next));

  if (expected === null) {
    // One-time client with work booked — that's all the signal there is.
    return { weight: 0, value: 1, detail: `${futureDates.length} future job(s), next in ${daysOut}d` };
  }
  const value = clamp01(1 - Math.max(0, daysOut / expected - 1));
  return {
    weight: 0,
    value,
    detail: `${futureDates.length} future job(s), next in ${daysOut}d vs ${expected}d cadence`,
  };
}

// ─── SMS tone via Claude ───────────────────────────────────────────

interface ToneResult {
  client_id: string;
  tone:      number;
  rationale: string;
}

const TONE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          client_id: { type: "string", description: "The client_id exactly as given in the input." },
          tone: {
            type: "number",
            description:
              "0.0 to 1.0. 1.0 = warm, satisfied, responsive. 0.5 = neutral or purely transactional. 0.0 = frustrated, complaining, cancelling, or gone unresponsive after outreach.",
          },
          rationale: { type: "string", description: "One short clause citing what in the thread drove the score." },
        },
        required: ["client_id", "tone", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

const TONE_SYSTEM = [
  "You read SMS threads between a residential cleaning company and its clients, and rate the client's",
  "sentiment toward the company.",
  "",
  "Rate ONLY the client's messages (direction Inbound). Outbound messages are the company and are context",
  "for interpreting the client's replies, not material to score.",
  "",
  "Scoring guidance:",
  "  1.0  warm, appreciative, easy — thanks the team, confirms readily, refers friends",
  "  0.7  positive but routine",
  "  0.5  purely transactional, or too little content to read sentiment either way",
  "  0.3  friction — repeated rescheduling, mild complaints, terse after a problem",
  "  0.0  frustrated, complaining, disputing charges, cancelling, or silent after several company messages",
  "",
  "An unanswered outbound thread (company messaged repeatedly, client never replied) scores low — around 0.2.",
  "A short but friendly exchange is NOT low; brevity alone is neutral (0.5), not negative.",
  "",
  "Return one entry per client_id you were given, using the client_id verbatim.",
].join("\n");

function renderThread(msgs: ProjectedMessage[]): string {
  return msgs
    .slice(-40) // newest 40 turns is plenty of signal and bounds the prompt
    .map((m) => {
      const who  = m.direction === "Inbound" ? "CLIENT" : "COMPANY";
      const when = (m.creationTime || "").slice(0, 10);
      const body = (m.body || "").replace(/\s+/g, " ").trim().slice(0, 400);
      return `[${when}] ${who}: ${body}`;
    })
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

async function scoreTonesBatch(
  batch: Array<{ client_id: string; name: string; msgs: ProjectedMessage[] }>,
): Promise<ToneResult[]> {
  const blocks = batch
    .map((b) => `<thread client_id="${b.client_id}" client_name="${b.name}">\n${renderThread(b.msgs)}\n</thread>`)
    .join("\n\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      // Opus 5 thinks by default and max_tokens caps thinking + response
      // together, so this is sized well above the ~800 tokens of JSON a
      // batch of 8 actually returns.
      max_tokens: 8192,
      system: TONE_SYSTEM,
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: TONE_SCHEMA },
      },
      messages: [{ role: "user", content: `Rate the client sentiment in each thread.\n\n${blocks}` }],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  // Structured outputs can still stop early; a refusal or a max_tokens
  // truncation yields no usable JSON. Treat both as "no tone signal"
  // rather than failing the whole scoring run.
  if (data.stop_reason === "refusal") {
    console.warn("[tone] request refused:", JSON.stringify(data.stop_details || {}));
    return [];
  }
  const textBlock = (data.content || []).find((b: Record<string, unknown>) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") return [];

  let parsed: { results?: ToneResult[] };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    console.warn("[tone] unparseable response:", (e as Error).message);
    return [];
  }
  return Array.isArray(parsed.results) ? parsed.results : [];
}

// ─── Handler ───────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Empty bearer token" });

  let payload: { business_id?: string; dry_run?: boolean } = {};
  if (req.headers.get("Content-Length") && req.headers.get("Content-Length") !== "0") {
    try { payload = await req.json(); } catch { /* empty body OK */ }
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Two caller modes, same shape as rc-inbox: service role (cron / EF-to-EF)
  // takes the tenant from the payload; a user JWT resolves it from the
  // caller's own row so a manager can trigger a run from the browser.
  const isServiceRole = jwt === SERVICE_KEY;
  let businessId: string | undefined;

  if (isServiceRole) {
    businessId = typeof payload.business_id === "string" ? payload.business_id : undefined;
    if (!businessId) return json(400, { error: "business_id is required for service-role calls" });
  } else {
    const caller = createClient(SUPABASE_URL, ANON_KEY);
    const { data: callerData, error: callerErr } = await caller.auth.getUser(jwt);
    if (callerErr)          return json(401, { error: "Invalid JWT", detail: callerErr.message });
    if (!callerData.user)   return json(401, { error: "Invalid JWT (no user)" });
    const userRow = await admin
      .from("users").select("business_id").eq("auth_user_id", callerData.user.id).maybeSingle();
    businessId = userRow.data?.business_id;
    if (!businessId) return json(403, { error: "No tenant for caller" });
  }

  // Step 1: config.
  const bizRes = await admin
    .from("businesses").select("business_settings").eq("id", businessId).maybeSingle();
  if (bizRes.error) return json(500, { error: "Failed to load business", detail: bizRes.error.message });

  const raw = (bizRes.data?.business_settings as Record<string, unknown> | null)?.client_health;
  const cfg: HealthConfig = { ...DEFAULT_CONFIG, ...(raw as Partial<HealthConfig> || {}) };
  cfg.weights = { ...DEFAULT_CONFIG.weights, ...(cfg.weights || {}) };
  if (!cfg.enabled) return json(200, { skipped: true, reason: "client_health.enabled is false" });

  const lookback = Math.max(1, Math.min(12, Math.floor(Number(cfg.sms_lookback_months) || 3)));

  // Step 2: the scored set — status='active' AND deleted_at IS NULL.
  // NOT clients.active, which is vestigial and reads true for every row
  // including the ones that are status='inactive'.
  const clientsRes = await admin
    .from("clients")
    .select("id, external_id, first_name, last_name, phone, additional_phones, frequency, frequency_days")
    .eq("business_id", businessId)
    .eq("status", "active")
    .is("deleted_at", null);
  if (clientsRes.error) return json(500, { error: "Failed to load clients", detail: clientsRes.error.message });
  const clients = (clientsRes.data || []) as ClientRow[];
  if (clients.length === 0) return json(200, { skipped: true, reason: "no active clients" });

  // Step 3: jobs. 180d of history (revenue trend needs two 90d windows)
  // plus everything future (forward booking).
  const now      = new Date();
  const from180  = new Date(now.getTime() - 180 * DAY_MS).toISOString().slice(0, 10);
  const jobsRes  = await admin
    .from("jobs")
    .select("client_id, date, price, status")
    .eq("business_id", businessId)
    .gte("date", from180);
  if (jobsRes.error) return json(500, { error: "Failed to load jobs", detail: jobsRes.error.message });

  // jobs.client_id is TEXT and joins clients.external_id, not clients.id.
  const jobsByExternal = new Map<string, JobRow[]>();
  for (const j of (jobsRes.data || []) as JobRow[]) {
    if (!j.client_id) continue;
    const arr = jobsByExternal.get(j.client_id);
    if (arr) arr.push(j);
    else jobsByExternal.set(j.client_id, [j]);
  }

  // Step 4: ONE rc-inbox call for the whole tenant (see header).
  const smsByPhone = new Map<string, ProjectedMessage[]>();
  let smsStatus  = "ok";
  let smsCount   = 0;
  let smsPartial = false;

  try {
    const inboxResp = await fetch(`${SUPABASE_URL}/functions/v1/rc-inbox`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:   `Bearer ${SERVICE_KEY}`,
        apikey:          SERVICE_KEY,
      },
      body: JSON.stringify({ business_id: businessId, months_back: lookback }),
    });
    if (!inboxResp.ok) {
      // A tenant with no RC integration (424) is a normal state, not a
      // failure — sms_tone just goes null and its weight redistributes.
      smsStatus = `rc-inbox ${inboxResp.status}: ${(await inboxResp.text()).slice(0, 200)}`;
      console.warn("[score-client-health]", smsStatus);
    } else {
      const inbox = await inboxResp.json();
      const msgs  = Array.isArray(inbox.messages) ? (inbox.messages as ProjectedMessage[]) : [];
      smsCount   = msgs.length;
      smsPartial = inbox.partial === true;
      for (const m of msgs) {
        // Bucket under the counterparty's number: for inbound that's the
        // sender, for outbound every recipient.
        const keys = m.direction === "Inbound"
          ? [last10(m.from?.phoneNumber)]
          : (m.to || []).map((t) => last10(t.phoneNumber));
        for (const k of keys) {
          if (!k) continue;
          const arr = smsByPhone.get(k);
          if (arr) arr.push(m);
          else smsByPhone.set(k, [m]);
        }
      }
      for (const arr of smsByPhone.values()) {
        arr.sort((a, b) => (a.creationTime || "").localeCompare(b.creationTime || ""));
      }
    }
  } catch (e) {
    smsStatus = `rc-inbox threw: ${(e as Error).message}`;
    console.warn("[score-client-health]", smsStatus);
  }

  // Step 5: deterministic factors per client, and collect SMS work.
  interface Pending {
    client:  ClientRow;
    factors: Record<string, Factor>;
    msgs:    ProjectedMessage[];
  }
  const pending: Pending[] = [];

  for (const c of clients) {
    const expected = expectedIntervalDays(c);
    const jobs     = c.external_id ? (jobsByExternal.get(c.external_id) || []) : [];

    const pastJobs: JobRow[] = [];
    const pastDates: Date[]  = [];
    const futureDates: Date[] = [];
    for (const j of jobs) {
      const d = new Date(j.date + "T00:00:00Z");
      if (d <= now) { pastJobs.push(j); pastDates.push(d); }
      else futureDates.push(d);
    }
    pastDates.sort((a, b) => a.getTime() - b.getTime());
    futureDates.sort((a, b) => a.getTime() - b.getTime());

    // Every phone the client is reachable at, so a thread on a secondary
    // number still counts.
    const phoneKeys = [last10(c.phone), ...((c.additional_phones || []).map(last10))]
      .filter((x): x is string => !!x);
    const seen = new Set<string>();
    const msgs: ProjectedMessage[] = [];
    for (const k of phoneKeys) {
      for (const m of (smsByPhone.get(k) || [])) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        msgs.push(m);
      }
    }
    msgs.sort((a, b) => (a.creationTime || "").localeCompare(b.creationTime || ""));

    const factors: Record<string, Factor> = {
      cadence_adherence: cadenceAdherence(pastDates, expected, now),
      revenue_trend:     revenueTrend(pastJobs, now),
      forward_booking:   forwardBooking(futureDates, expected, pastDates.length, now),
      sms_tone:          { weight: 0, value: null, detail: "no SMS thread in the lookback window" },
      // Dormant. Present so the jsonb shape is stable and so the reason
      // they're dormant is recorded alongside every historical score.
      completion_rate: { weight: 0, value: null, detail: "dormant: jobs.status is not maintained by the app" },
      cancel_rate:     { weight: 0, value: null, detail: "dormant: too few cancellations to score" },
      incident_rate:   { weight: 0, value: null, detail: "dormant: too few incidents to score" },
    };

    pending.push({ client: c, factors, msgs });
  }

  // Step 6: SMS tone, batched. Only clients that actually have a thread
  // are sent — most won't, and empty threads carry no signal.
  const withSms = pending.filter((p) => p.msgs.length > 0);
  let toneScored = 0;
  let toneFailed = 0;

  if (ANTHROPIC_KEY && withSms.length > 0) {
    const BATCH = 8;
    for (let i = 0; i < withSms.length; i += BATCH) {
      const slice = withSms.slice(i, i + BATCH);
      try {
        const results = await scoreTonesBatch(
          slice.map((p) => ({
            client_id: p.client.id,
            name:      `${p.client.first_name} ${p.client.last_name || ""}`.trim(),
            msgs:      p.msgs,
          })),
        );
        const byId = new Map(results.map((r) => [r.client_id, r]));
        for (const p of slice) {
          const r = byId.get(p.client.id);
          if (!r || typeof r.tone !== "number") continue;
          p.factors.sms_tone = {
            weight: 0,
            value:  clamp01(r.tone),
            detail: `${p.msgs.length} msg thread — ${String(r.rationale || "").slice(0, 160)}`,
          };
          toneScored++;
        }
      } catch (e) {
        // One bad batch must not sink the run; those clients keep a null
        // tone and their weight redistributes.
        toneFailed += slice.length;
        console.warn("[score-client-health] tone batch failed:", (e as Error).message);
      }
    }
  }

  // Step 7: combine. Weights are redistributed across the factors that
  // actually produced a value — otherwise a client with no SMS thread
  // would be capped at 75/100 for having no data, which reads as a
  // problem with the client rather than a gap in what we can see.
  const scores: Array<{
    client_id: string; score: number; band: string;
    factors: Record<string, Factor>; summary: string;
  }> = [];

  for (const p of pending) {
    let active = 0;
    for (const [name, f] of Object.entries(p.factors)) {
      const w = Number(cfg.weights[name] ?? 0);
      if (w > 0 && f.value !== null) active += w;
    }

    let score: number;
    let summary: string;

    if (active <= 0) {
      score = 50;
      summary = "Not enough activity to score — no cadence, revenue, booking, or SMS signal available.";
      for (const f of Object.values(p.factors)) f.weight = 0;
    } else {
      let acc = 0;
      for (const [name, f] of Object.entries(p.factors)) {
        const w = Number(cfg.weights[name] ?? 0);
        if (w > 0 && f.value !== null) {
          const norm = w / active;
          f.weight = Number(norm.toFixed(4));
          acc += norm * f.value;
        } else {
          f.weight = 0;
        }
      }
      score = Math.round(clamp01(acc) * 100);

      // Summary names the weakest contributing factor — that's the one
      // worth acting on, and it's what the dashboard surfaces per client.
      const contributing = Object.entries(p.factors)
        .filter(([, f]) => f.weight > 0 && f.value !== null)
        .sort((a, b) => (a[1].value as number) - (b[1].value as number));
      const [weakName, weakFactor] = contributing[0];
      const label = weakName.replace(/_/g, " ");
      summary = score >= 70
        ? `Healthy. Weakest signal: ${label} — ${weakFactor.detail}.`
        : `${score >= 40 ? "Watch" : "At risk"}. Driven by ${label} — ${weakFactor.detail}.`;
    }

    scores.push({
      client_id: p.client.id,
      score,
      band: bandFor(score),
      factors: p.factors,
      summary,
    });
  }

  const bandCounts = scores.reduce<Record<string, number>>((acc, s) => {
    acc[s.band] = (acc[s.band] || 0) + 1;
    return acc;
  }, {});

  const smsMeta = {
    status: smsStatus,
    messages_pulled: smsCount,
    partial: smsPartial,
    threads_matched: withSms.length,
    tone_scored: toneScored,
    tone_failed: toneFailed,
    lookback_months: lookback,
  };

  if (payload.dry_run === true) {
    return json(200, { dry_run: true, scored: scores.length, band_counts: bandCounts, sms: smsMeta, scores });
  }

  // Step 8: record the run. One statement, one transaction — a partially
  // written run would corrupt the sharp-drop query, which assumes the
  // newest run is complete.
  const runId = crypto.randomUUID();
  const rec = await admin.rpc("record_client_health_run", {
    p_business_id: businessId,
    p_run_id:      runId,
    p_scores:      scores,
  });
  if (rec.error) return json(500, { error: "Failed to record run", detail: rec.error.message });

  return json(200, {
    run_id: runId,
    scored: rec.data,
    band_counts: bandCounts,
    sms: smsMeta,
  });
});
