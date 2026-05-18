// Edge Function: claire-chat
//
// Server-side proxy for the Anthropic Messages API. Holds
// ANTHROPIC_API_KEY as a Supabase secret so the key never ships in the
// browser bundle. Replaces every browser-side direct fetch to
// api.anthropic.com/v1/messages in index.html (8 sites — Claire's
// tool-use loop, AI reply drafting, video caption generation, employee
// AI assistant, translate paths).
//
// Pass-through proxy: whatever shape the browser POSTs (model,
// max_tokens, system, tools, messages, stream, etc.) goes upstream
// verbatim, plus the x-api-key + anthropic-version + anthropic-beta
// headers we attach server-side. Whatever Anthropic returns — JSON
// body or SSE stream — is piped back to the browser.
//
// Streaming: pass-through works for both `stream: false` (default,
// returns JSON) and `stream: true` (returns text/event-stream). All
// current call sites are non-streaming, but the EF doesn't need a
// branch — Anthropic decides based on the request body, we just
// forward.
//
// Tool loop runs CLIENT-SIDE. Anthropic returns tool_use blocks; the
// browser executes the tool locally; sends a tool_result block back
// on the next round. The EF is stateless — every round is a separate
// invoke call.
//
// Rate limit: 300/hour per caller via check_rate_limit. Claire's tool
// loop can fire up to MAX_TOOL_ROUNDS=10 rounds per user message, so
// 300/hr = ~30 user messages per hour per manager. Well above
// legitimate use, tight enough to catch a runaway loop within seconds.
//
// Required secrets:
//   ANTHROPIC_API_KEY — set in Supabase Dashboard → Project Settings →
//                       Edge Functions → Secrets. Get from
//                       console.anthropic.com → API keys.
//
// Request shape (pass-through):
//   POST { model, max_tokens, system?, tools?, messages, stream? }
// Response (pass-through):
//   200 — Anthropic JSON body (or SSE stream if stream: true)
//   400 — bad body
//   401 — missing/invalid Supabase JWT
//   429 — local rate limit OR Anthropic upstream rate limit
//   502 — Anthropic returned non-2xx (status forwarded in body)

import { serve }       from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY") || "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY env var");
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
if (!ANTHROPIC_KEY) console.warn("[claire-chat] ANTHROPIC_API_KEY env var not set — every request will 502");

const ANTHROPIC_VERSION = "2023-06-01";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  // Auth (verify_jwt:true already gates at gateway; we surface a friendlier 401)
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Empty bearer token" });
  const caller = createClient(SUPABASE_URL, ANON_KEY);
  const { data: callerData, error: callerErr } = await caller.auth.getUser(jwt);
  if (callerErr) {
    console.error("[claire-chat] auth getUser failed:", callerErr.message);
    return json(401, { error: "Invalid JWT", detail: callerErr.message });
  }
  if (!callerData.user) return json(401, { error: "Invalid JWT (no user)" });
  const callerAuthId = callerData.user.id;

  // Rate limit: 300/hr per user. Fail-open on RPC error.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: rateOk, error: rateErr } = await admin.rpc("check_rate_limit", {
    p_key:            `claire-chat:${callerAuthId}`,
    p_max_calls:      300,
    p_window_seconds: 3600,
  });
  if (rateErr) {
    console.error("[claire-chat] rate limit RPC failed:", rateErr);
  } else if (rateOk === false) {
    return json(429, {
      error: "Rate limit exceeded",
      hint:  "300/hour Claire-chat limit reached. Wait before retrying.",
    });
  }

  // Read the raw body bytes so we can forward them unchanged. Validate
  // it's JSON-parseable up front to give a useful 400 on garbage.
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch (e) {
    return json(400, { error: "Could not read request body", detail: (e as Error).message });
  }
  try {
    JSON.parse(bodyText);
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (!ANTHROPIC_KEY) {
    return json(502, { error: "ANTHROPIC_API_KEY not configured server-side" });
  }

  // Forward to Anthropic. Whatever they return (JSON or SSE) gets
  // piped back as-is. Caller decides streaming via `stream: true` in
  // the request body.
  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: bodyText,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error("[claire-chat] upstream fetch threw:", msg);
    return json(502, { error: "Anthropic fetch failed", detail: msg });
  }

  // Anthropic non-2xx: log + forward status + body. The browser surfaces
  // the detail via supabase-js's res.error / res.data path.
  if (!upstream.ok) {
    const detail = await upstream.text();
    console.error(`[claire-chat] Anthropic ${upstream.status}:`, detail.slice(0, 300));
    // 429 stays 429 (caller can back off). Everything else folded to 502
    // since they're upstream failures rather than our config.
    const outStatus = upstream.status === 429 ? 429 : 502;
    return json(outStatus, {
      error:  "Anthropic error",
      status: upstream.status,
      detail,
    });
  }

  // Success: stream the body through (works for both JSON + SSE).
  const upstreamCt = upstream.headers.get("Content-Type") || "application/json";
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": upstreamCt,
      // Surface anthropic request id for tracing if upstream provided one.
      ...(upstream.headers.get("request-id")
          ? { "x-anthropic-request-id": upstream.headers.get("request-id") as string }
          : {}),
    },
  });
});
