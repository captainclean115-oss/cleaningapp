// Edge Function: send-sms
//
// v11.0.2 (Item B) — per-tenant phone provider integrations.
//
// Server-side SMS sender. Was originally hardcoded to Manna Maids'
// RingCentral credentials in Supabase secrets. Now resolves the
// caller's tenant from JWT, looks up that tenant's
// business_phone_integrations row, and uses its credentials +
// outbound number.
//
// Migration-safe fallback: when an integration row's credentials JSONB
// has `{"source":"env"}` (Manna Maids' transitional state during the
// v11.0.2 migration), the function reads from the existing
// RC_CLIENT_ID / RC_CLIENT_SECRET / RC_REFRESH_TOKEN env vars. This
// lets the existing tenant keep working while new tenants store actual
// credentials in the table. Rotate Manna Maids out of env-source by
// updating the credentials jsonb in-place.
//
// Deploy:
//   supabase functions deploy send-sms --project-ref wymoezilyjmyibmuqqmr
//
// Required secrets (only while at least one tenant uses env-source):
//   RC_CLIENT_ID, RC_CLIENT_SECRET, RC_REFRESH_TOKEN
// RC_FROM_NUMBER env was previously authoritative; now the from-number
// comes from the integration row's phone_number_e164 column. Env var
// becomes a last-ditch fallback only.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
// Service-role key for the privileged client used to look up integration
// rows. The lookup goes through SECURITY DEFINER RPC, but the client
// invoking the RPC needs to be authenticated — service_role bypasses
// the authenticated-user requirement entirely.
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Legacy env-source fallbacks. Used only when integrations row's
// credentials JSONB is {"source":"env"}.
const ENV_RC_CLIENT_ID     = Deno.env.get("RC_CLIENT_ID")     || "";
const ENV_RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET") || "";
const ENV_RC_REFRESH_TOKEN = Deno.env.get("RC_REFRESH_TOKEN") || "";
const ENV_RC_FROM_NUMBER   = Deno.env.get("RC_FROM_NUMBER")   || "";

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

interface RcCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

async function rcAccessToken(creds: RcCreds): Promise<string> {
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  const resp = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refreshToken)}`,
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
  if (req.method !== "POST")    return json(405, { error: "Method not allowed" });

  // Step 1: caller auth + tenant resolution.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerData, error: callerErr } = await caller.auth.getUser();
  if (callerErr || !callerData.user) return json(401, { error: "Invalid JWT" });
  const callerAuthId = callerData.user.id;

  // Resolve tenant from users.business_id.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userRow = await admin.from("users").select("business_id").eq("id", callerAuthId).maybeSingle();
  const businessId = userRow.data?.business_id;
  if (!businessId) return json(403, { error: "No tenant for caller" });

  // Step 2: parse payload.
  let body: { to_phone?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const toRaw   = (body.to_phone || "").toString();
  const message = (body.message  || "").toString();
  if (!toRaw)   return json(400, { error: "Missing to_phone" });
  if (!message) return json(400, { error: "Missing message" });
  const to = toE164(toRaw);
  if (!to) return json(400, { error: "Could not parse to_phone to E.164" });

  // Step 3: resolve this tenant's RC integration.
  const integ = await admin.rpc("get_active_phone_integration", {
    p_business_id: businessId,
    p_provider:    "ringcentral",
  });
  const row = (integ.data && integ.data[0]) || null;
  if (!row) {
    return json(424, {
      error: "No active RingCentral integration configured for this tenant",
      hint:  "Add a row to business_phone_integrations or have an owner/admin set it up in Settings."
    });
  }

  // Step 4: resolve credentials. Env-source means "use the platform
  // env vars" (Manna Maids' transitional state). Otherwise read the
  // credentials directly from the JSONB.
  const credsJson = (row.credentials || {}) as Record<string, unknown>;
  let creds: RcCreds;
  let fromNumber = row.phone_number_e164 || ENV_RC_FROM_NUMBER;
  if (credsJson.source === "env") {
    creds = {
      clientId:     ENV_RC_CLIENT_ID,
      clientSecret: ENV_RC_CLIENT_SECRET,
      refreshToken: ENV_RC_REFRESH_TOKEN,
    };
  } else {
    creds = {
      clientId:     String(credsJson.client_id     || ""),
      clientSecret: String(credsJson.client_secret || ""),
      refreshToken: String(credsJson.refresh_token || ""),
    };
  }
  for (const k of ["clientId","clientSecret","refreshToken"] as const) {
    if (!creds[k]) {
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `Missing credential field: ${k}`,
      });
      return json(500, { error: `Integration credentials incomplete (missing ${k})` });
    }
  }
  if (!fromNumber) return json(500, { error: "Integration phone_number_e164 not set" });

  // Step 5: refresh token + send.
  try {
    const accessToken = await rcAccessToken(creds);
    const sendResp = await fetch(
      "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { phoneNumber: fromNumber },
          to:   [{ phoneNumber: to }],
          text: message,
        }),
      },
    );
    if (!sendResp.ok) {
      const detail = await sendResp.text();
      await admin.rpc("mark_phone_integration_error", {
        p_business_id: businessId,
        p_provider:    "ringcentral",
        p_error:       `RC SMS send ${sendResp.status}: ${detail.slice(0, 200)}`,
      });
      return json(502, { error: "RC SMS send failed", status: sendResp.status, detail });
    }
    const sent = await sendResp.json();
    await admin.rpc("mark_phone_integration_used", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
    });
    return json(200, { ok: true, msg_id: sent.id, to, from: fromNumber });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await admin.rpc("mark_phone_integration_error", {
      p_business_id: businessId,
      p_provider:    "ringcentral",
      p_error:       msg,
    });
    return json(500, { error: "SMS exception", detail: msg });
  }
});
