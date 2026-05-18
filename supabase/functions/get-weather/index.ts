// Edge Function: get-weather
//
// Server-side OpenWeatherMap forecast proxy. Holds OPENWEATHER_API_KEY
// as a Supabase secret so the key never ships in the browser bundle.
// Replaces the browser-side fetch chain in index.html's
// fetchWeatherForecast (constants + direct fetch deleted in the same
// PR — see docs/06-technical-architecture.md).
//
// Proxies the /data/2.5/forecast endpoint (multi-day, 3-hour resolution)
// and returns the raw upstream JSON. The browser's existing byDay
// transform (noon-ish entry per date) is preserved client-side — the
// EF just makes the upstream call invisible.
//
// In-memory cache: 10min per (lat, lon, units) tuple, keyed by
// `${lat.toFixed(3)}:${lon.toFixed(3)}:${units}` so tiny float drift
// across browsers doesn't bust the cache. Per-Edge-Function-instance,
// not global. Stacks under the browser's 3-hour localStorage cache, so
// upstream API hits are well under OpenWeatherMap's free-tier limits.
//
// Deploy:
//   supabase functions deploy get-weather --project-ref wymoezilyjmyibmuqqmr
//
// Required secrets:
//   OPENWEATHER_API_KEY — set in Supabase Dashboard → Project Settings →
//                         Edge Functions → Secrets. Get from
//                         openweathermap.org → API keys.
//
// Request shape:
//   POST { lat: number, lon: number, units?: "imperial" | "metric" }
// Response:
//   200 — raw OpenWeather forecast payload (cod, message, cnt, list, city)
//   400 — bad body (missing/non-numeric lat/lon)
//   401 — missing/invalid JWT
//   502 — upstream OpenWeather failure

import { serve }       from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY") || "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY env var");
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OWM_KEY      = Deno.env.get("OPENWEATHER_API_KEY") || "";
if (!OWM_KEY) console.warn("[get-weather] OPENWEATHER_API_KEY env var not set — every request will 502");

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

const cache = new Map<string, { data: unknown; expiresAt: number }>();
const TTL_MS = 10 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  // Auth: verify_jwt:true at the gateway already 401s missing headers,
  // but we surface a friendlier error and use the JWT downstream if we
  // need it later (rate limiting etc).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Empty bearer token" });
  const caller = createClient(SUPABASE_URL, ANON_KEY);
  const { data: callerData, error: callerErr } = await caller.auth.getUser(jwt);
  if (callerErr) {
    console.error("[get-weather] auth getUser failed:", callerErr.message);
    return json(401, { error: "Invalid JWT", detail: callerErr.message });
  }
  if (!callerData.user) return json(401, { error: "Invalid JWT (no user)" });
  const callerAuthId = callerData.user.id;

  // Rate limit (security audit 3b): 60/hr per user, split check/inc.
  // The 10min EF in-memory cache + 3h browser localStorage cache already
  // absorb almost all traffic; this limit only catches abuse (e.g., a
  // tight client-side loop). Cache hits skip the increment entirely so
  // they don't consume budget.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userRateKey = `user:${callerAuthId}:get-weather`;
  const USER_LIMIT  = 60;
  const checkRes = await admin.rpc("rate_limit_check", {
    p_key: userRateKey, p_max: USER_LIMIT, p_window_seconds: 3600,
  });
  if (checkRes.error) {
    console.error("[get-weather] rate_limit_check failed:", checkRes.error);
  } else if (checkRes.data === false) {
    return json(429, {
      error:  "rate_limit_exceeded",
      detail: `Per-user limit ${USER_LIMIT}/hr exceeded for get-weather`,
    });
  }

  // Parse + validate body
  let body: { lat?: unknown; lon?: unknown; units?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || lat <  -90 || lat >  90)  return json(400, { error: "lat must be a finite number in [-90, 90]" });
  if (!Number.isFinite(lon) || lon < -180 || lon > 180)  return json(400, { error: "lon must be a finite number in [-180, 180]" });
  const units = body.units === "metric" ? "metric" : "imperial";

  // Cache check
  const cacheKey = `${lat.toFixed(3)}:${lon.toFixed(3)}:${units}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return json(200, hit.data);
  }

  if (!OWM_KEY) return json(502, { error: "OPENWEATHER_API_KEY not configured server-side" });

  const url = `https://api.openweathermap.org/data/2.5/forecast`
    + `?lat=${lat}&lon=${lon}&units=${units}&appid=${OWM_KEY}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error("[get-weather] upstream fetch threw:", msg);
    return json(502, { error: "OpenWeather fetch failed", detail: msg });
  }
  if (!resp.ok) {
    const detail = await resp.text();
    console.error(`[get-weather] OpenWeather ${resp.status}:`, detail.slice(0, 200));
    return json(502, { error: "OpenWeather error", status: resp.status, detail });
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return json(502, { error: "OpenWeather JSON parse failed", detail: msg });
  }

  cache.set(cacheKey, { data, expiresAt: Date.now() + TTL_MS });
  // mig 066: increment rate-limit only on a successful UPSTREAM call.
  // Cache hits above return early without consuming budget, which is
  // the right behavior — they're not making a real OpenWeather call.
  await admin.rpc("rate_limit_increment", { p_key: userRateKey, p_window_seconds: 3600 });
  return json(200, data);
});
