// Edge Function: send-sms
// Server-side SMS sender using RingCentral, called from the employee schedule's
// "On My Way" button. Stores RC OAuth refresh token as a Supabase secret so
// every team leader on every device can fire the SMS without each one
// re-authenticating with RingCentral.
//
// Deploy:
//   supabase functions deploy send-sms --project-ref wymoezilyjmyibmuqqmr
//
// Required secrets (set once via dashboard → Edge Functions → Secrets, OR
// `supabase secrets set KEY=value --project-ref wymoezilyjmyibmuqqmr`):
//   RC_CLIENT_ID      — from developers.ringcentral.com app → Credentials
//   RC_CLIENT_SECRET  — same place
//   RC_REFRESH_TOKEN  — capture this in the browser after rcConnect():
//                       `localStorage.getItem('rc_refresh')`
//   RC_FROM_NUMBER    — your RC primary number in E.164 (e.g. +15085598062)
//
// RC refresh tokens last 60 days by default. When this function refreshes the
// access token, RC returns a new refresh token in the response — we don't
// persist it here, so Tom will need to rotate the secret roughly bi-monthly
// (or extend with a settings-table write later).

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RC_CLIENT_ID = Deno.env.get("RC_CLIENT_ID")!;
const RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET")!;
const RC_REFRESH_TOKEN = Deno.env.get("RC_REFRESH_TOKEN")!;
const RC_FROM_NUMBER = Deno.env.get("RC_FROM_NUMBER")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toE164(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  if (digits.length > 7) return "+" + digits;
  return null;
}

async function rcAccessToken(): Promise<string> {
  const basic = btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`);
  const resp = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(RC_REFRESH_TOKEN)}`,
  });
  if (!resp.ok) {
    throw new Error(`RC OAuth refresh failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error("RC OAuth returned no access_token");
  return data.access_token as string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // Caller must be authenticated (we don't want random anonymous traffic
  // burning RC SMS quota / billing).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerData, error: callerErr } = await caller.auth.getUser();
  if (callerErr || !callerData.user) return json(401, { error: "Invalid JWT" });

  // Parse payload.
  let body: { to_phone?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const toRaw = (body.to_phone || "").toString();
  const message = (body.message || "").toString();
  if (!toRaw) return json(400, { error: "Missing to_phone" });
  if (!message) return json(400, { error: "Missing message" });

  const to = toE164(toRaw);
  if (!to) return json(400, { error: "Could not parse to_phone to E.164" });

  // Sanity-check secret presence — clearer than a runtime crash deep in fetch.
  for (const k of ["RC_CLIENT_ID", "RC_CLIENT_SECRET", "RC_REFRESH_TOKEN", "RC_FROM_NUMBER"]) {
    if (!Deno.env.get(k)) return json(500, { error: `Server missing ${k}` });
  }

  try {
    const accessToken = await rcAccessToken();
    const sendResp = await fetch(
      "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { phoneNumber: RC_FROM_NUMBER },
          to: [{ phoneNumber: to }],
          text: message,
        }),
      },
    );
    if (!sendResp.ok) {
      const detail = await sendResp.text();
      return json(502, { error: "RC SMS send failed", status: sendResp.status, detail });
    }
    const sent = await sendResp.json();
    return json(200, { ok: true, msg_id: sent.id, to });
  } catch (e) {
    return json(500, { error: "SMS exception", detail: (e as Error).message });
  }
});
