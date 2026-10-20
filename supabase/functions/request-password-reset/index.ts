// Edge Function: request-password-reset
// Public endpoint (no JWT -- she's locked out, that's the whole point).
// Deploy with: supabase functions deploy request-password-reset --project-ref wymoezilyjmyibmuqqmr --no-verify-jwt
//
// Takes ONLY a phone number. Looks up the matching active employee(s),
// generates a real Supabase recovery link via the Admin API (no email is
// ever sent by Supabase itself -- generateLink only returns the link, it
// does not deliver it), and texts that link via the business's own
// RingCentral integration. The response is byte-for-byte identical
// whether or not the phone is on file, so this endpoint can never be
// used to discover who works here.
//
// IMPORTANT -- link expiry is a Supabase PROJECT AUTH SETTING, not
// something this function (or SQL) controls. Verify/set it in the
// Supabase dashboard: Authentication -> Email -> "Email OTP expiry" (or
// the equivalent "recovery" token expiry field, naming varies by
// dashboard version) to 3600 seconds (60 minutes). This function cannot
// confirm or change that value -- it was not visible through any
// read-only SQL/MCP tool available this session.
//
// Rate limits (via the SAME generic rate_limit_check/increment RPCs
// send-sms already uses -- no new table): 3 requests per phone per hour,
// 10 requests per IP per hour. Both checked before any lookup, so a
// flood of requests for the SAME phone (or from the SAME IP across many
// phones) never reaches the employees table or RingCentral at all.
//
// Never logs the raw link or token -- only non-sensitive operational
// facts (whether a match was found, in aggregate, never to the caller).

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

// The ONE response shape for every "normal" outcome -- found or not
// found, one match or several, SMS delivered or not. Never varies.
const GENERIC_RESPONSE = { message: "If that number is on file, a text is on its way." };

// Minimal inline copy of send-sms's RC-auth + send logic. NOT reused via
// an HTTP call to send-sms itself: that function requires a caller JWT
// and resolves the business from IT (auth.getUser(jwt) -> users.business_id)
// -- there is no caller JWT here at all, this request is pre-auth by
// design. Re-deriving the business from the phone lookup instead and
// sending directly keeps send-sms itself completely untouched.
async function sendResetText(admin: ReturnType<typeof createClient>, businessId: string, toPhoneDigits: string, link: string): Promise<boolean> {
  const integ = await admin.rpc("get_active_phone_integration", {
    p_business_id: businessId,
    p_provider: "ringcentral",
  });
  const row = (integ.data && integ.data[0]) || null;
  if (!row) {
    console.error("[request-password-reset] no active RC integration for business", businessId);
    return false;
  }
  const credsJson = (row.credentials || {}) as Record<string, unknown>;
  const fromNumber = row.phone_number_e164 as string | undefined;
  if (!fromNumber) return false;

  let body: string;
  if (credsJson.auth_method === "jwt") {
    const jwtCredential = String(credsJson.jwt_credential || "");
    if (!jwtCredential) return false;
    body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwtCredential)}`;
  } else {
    const refreshToken = String(credsJson.refresh_token || "");
    if (!refreshToken) return false;
    body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  }
  const clientId = String(credsJson.client_id || "");
  const clientSecret = String(credsJson.client_secret || "");
  if (!clientId || !clientSecret) return false;
  const basic = btoa(`${clientId}:${clientSecret}`);

  try {
    const tokenResp = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!tokenResp.ok) {
      console.error("[request-password-reset] RC token fetch failed:", tokenResp.status);
      return false;
    }
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token as string | undefined;
    if (!accessToken) return false;

    // Message text itself is never logged -- it's built in-memory and
    // sent directly, same discipline as the generateLink call above.
    const text = `Penta password reset: ${link} (expires soon, use once). Didn't request this? Ignore this text.`;
    const sendResp = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: fromNumber }, to: [{ phoneNumber: "+1" + toPhoneDigits }], text }),
    });
    if (!sendResp.ok) {
      console.error("[request-password-reset] RC send failed:", sendResp.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[request-password-reset] RC send threw:", (e as Error).message);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  let payload: { phone?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const rawPhone = payload.phone;
  if (!rawPhone || typeof rawPhone !== "string") return json(400, { error: "Missing phone" });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const normalized = normalizePhone(rawPhone);

  // Rate limits checked BEFORE any lookup -- an exceeded limit returns
  // the EXACT SAME generic response (not a distinct "rate limited"
  // message), so hammering this endpoint can't be used to distinguish
  // "real phone, now rate-limited" from "fake phone" either.
  const phoneKey = `reset:phone:${normalized || rawPhone}`;
  const ipKey = `reset:ip:${ip}`;
  const phoneCheck = await admin.rpc("rate_limit_check", { p_key: phoneKey, p_max: 3, p_window_seconds: 3600 });
  const ipCheck = await admin.rpc("rate_limit_check", { p_key: ipKey, p_max: 10, p_window_seconds: 3600 });
  const rateLimited = (phoneCheck.data === false) || (ipCheck.data === false);
  // Always increment both (best-effort) regardless of outcome below --
  // every request against this endpoint counts toward the limit, found
  // or not, so probing can't avoid consuming budget.
  admin.rpc("rate_limit_increment", { p_key: phoneKey, p_window_seconds: 3600 }).catch(() => {});
  admin.rpc("rate_limit_increment", { p_key: ipKey, p_window_seconds: 3600 }).catch(() => {});

  if (rateLimited || !normalized) {
    return json(200, GENERIC_RESPONSE);
  }

  const { data: matches, error: lookupErr } = await admin
    .from("employees")
    .select("id, email, business_id, status")
    .eq("status", "active")
    .not("phone", "is", null);
  if (lookupErr) {
    console.error("[request-password-reset] employees lookup failed:", lookupErr);
    // A genuine infrastructure failure, not "phone not found" -- still
    // returns the generic message (even a DB hiccup must not leak
    // whether the phone exists), but logged distinctly for operators.
    return json(200, GENERIC_RESPONSE);
  }
  const candidates = (matches || []).filter((e) => normalizePhone(e.phone as unknown as string) === normalized);

  if (!candidates.length) {
    // No match -- still the identical response, no SMS attempted.
    return json(200, GENERIC_RESPONSE);
  }

  // One text per matching account (handles the confirmed-live edge case
  // of two active employees sharing a phone number -- see this
  // function's own file header). Each link is independently single-use.
  //
  // CORRECTION (caught in review before this ever shipped): an earlier
  // draft of this function returned a DISTINCT response (502
  // "sms_unavailable") when RingCentral itself was unreachable, reasoning
  // that it "describes a system state, not a per-phone fact." That
  // reasoning was wrong -- this loop only ever runs AT ALL when
  // `candidates.length > 0`, i.e. only for a phone that matched a real
  // employee. A made-up phone number NEVER reaches this code, so it can
  // never produce that 502 either. During a real RingCentral outage, a
  // real employee's number would get a DIFFERENT response than a fake
  // one -- exactly the enumeration leak this endpoint exists to prevent.
  // Every outcome below is now logged for operators (never the raw
  // link/token) but never changes what the CALLER receives -- that is
  // always the one GENERIC_RESPONSE, returned once, after the loop.
  for (const emp of candidates) {
    if (!emp.email) continue;
    try {
      const linkRes = await admin.auth.admin.generateLink({
        type: "recovery",
        email: emp.email as unknown as string,
        options: { redirectTo: "https://captainclean115-oss.github.io/cleaningapp/reset.html" },
      });
      if (linkRes.error || !linkRes.data?.properties?.action_link) {
        console.error("[request-password-reset] generateLink failed for an employee (id redacted from log)");
        continue;
      }
      const link = linkRes.data.properties.action_link;
      const sent = await sendResetText(admin, emp.business_id as unknown as string, normalized, link);
      if (!sent) console.error("[request-password-reset] SMS send failed for an employee (id redacted from log) -- RingCentral unreachable or misconfigured for this business");
    } catch (e) {
      console.error("[request-password-reset] reset attempt threw:", (e as Error).message);
    }
  }

  return json(200, GENERIC_RESPONSE);
});
