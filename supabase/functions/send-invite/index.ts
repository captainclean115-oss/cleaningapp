// Edge Function: send-invite
// Caller: a real owner/manager JWT is required (this is NOT a public
// endpoint like accept-invite/phone-login/request-password-reset --
// sending an invite is a manager action, not something a not-yet-
// invited employee or an anonymous caller can ever trigger).
// Deploy with: supabase functions deploy send-invite --project-ref wymoezilyjmyibmuqqmr
//
// Input: { employee_id } ONLY. Never accepts a client-supplied phone
// number or message text -- both are always resolved/built server-side
// from the employee's own row and a fixed template, so a compromised or
// buggy client can't make this function text an arbitrary number or an
// arbitrary message. Generates a fresh invite token + employee_invites
// row (same shape pentaSendInvite's client-side code used to write),
// builds the fixed-template text, and sends it via the business's own
// RingCentral integration -- the SAME sender logic request-password-
// reset's sendResetText uses (copied here, not re-derived differently,
// so the two Edge Functions' RC-calling behavior can't drift apart).
//
// Returns ONLY { success: true } or { success: false, error: <plain
// reason> } -- never the phone number, the message, the link, or the
// token, to the caller OR to any console.log. A manager who needs the
// actual link (e.g. the SMS send failed and she wants a fallback) reads
// it a SEPARATE way: employee_invites.token is already readable by her
// own RLS-scoped client session (emp_invites_select policy: owner/
// admin/manager), so the Staff screen's own "Copy invite link" button
// queries that table directly -- this function doesn't need to expose
// the token for that to work.
//
// Rate limit (defense in depth, same generic RPCs every other Edge
// Function in this app uses): 5 invites per employee per hour (stops a
// client-side bug from spamming one person with texts), 100 per caller
// per hour (same per-user ceiling send-sms already uses).

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
if (!ANON_KEY) throw new Error("Missing SUPABASE_ANON_KEY env var");

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

function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

// Invite-collision guard: the exact same synthetic-email shape
// accept-invite's phoneDerivedEmail() produces -- kept here too so
// this pre-check can compute it without importing across function
// boundaries (Edge Functions are deployed independently; copied, not
// re-derived differently, same reasoning this file's own header
// comment already gives for sendInviteText).
function derivePhoneEmail(normalizedPhone: string): string {
  return `${normalizedPhone}@phone.penta.internal`;
}

// Pure, no I/O -- unit-testable in isolation. `allEmployees` is every
// employee row in the business (ANY status, including terminated --
// a stale fixture row can still be squatting on a real login). Only a
// row that ALREADY has a login (auth_user_id set) is a real collision
// risk; a row with no login yet just means two people happen to share
// a phone today, which the existing client-side active/active check
// already catches separately.
function findPhoneCollision(
  targetEmployeeId: string,
  normalizedPhone: string,
  allEmployees: Array<{ id: string; first_name?: string | null; last_name?: string | null; phone?: string | null; email?: string | null; auth_user_id?: string | null }>
): { id: string; first_name: string | null; last_name: string | null } | null {
  const derivedEmail = derivePhoneEmail(normalizedPhone);
  for (const row of allEmployees) {
    if (row.id === targetEmployeeId) continue; // re-inviting herself is never a collision
    if (!row.auth_user_id) continue; // no login yet -- not a collision risk
    const rowEmail = (row.email || "").toLowerCase();
    const rowNormalizedPhone = normalizePhone(row.phone || "");
    if (rowEmail === derivedEmail || rowNormalizedPhone === normalizedPhone) {
      return { id: row.id, first_name: row.first_name ?? null, last_name: row.last_name ?? null };
    }
  }
  return null;
}

// Same 32-random-byte, base64url, no-padding shape pentaGenerateInviteToken()
// already produces client-side (index.html) -- not required to match
// byte-for-byte, just matching the existing convention for consistency.
function generateInviteToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Minimal inline copy of send-sms's/request-password-reset's RC-auth +
// send logic -- same reasoning request-password-reset's own comment
// gives for not proxying through send-sms via HTTP: parametrized by the
// already-built text, never re-derives it from anything client-supplied.
async function sendInviteText(admin: ReturnType<typeof createClient>, businessId: string, toPhoneDigits: string, text: string): Promise<boolean> {
  const integ = await admin.rpc("get_active_phone_integration", {
    p_business_id: businessId,
    p_provider: "ringcentral",
  });
  const row = (integ.data && integ.data[0]) || null;
  if (!row) {
    console.error("[send-invite] no active RC integration for business", businessId);
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
      console.error("[send-invite] RC token fetch failed:", tokenResp.status);
      return false;
    }
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token as string | undefined;
    if (!accessToken) return false;

    // Text is built in-memory and sent directly -- never logged, same
    // discipline as request-password-reset's own reset link.
    const sendResp = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: fromNumber }, to: [{ phoneNumber: "+1" + toPhoneDigits }], text }),
    });
    if (!sendResp.ok) {
      console.error("[send-invite] RC send failed:", sendResp.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[send-invite] RC send threw:", (e as Error).message);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json(401, { error: "Empty bearer token" });

  const caller = createClient(SUPABASE_URL, ANON_KEY);
  const { data: callerData, error: callerErr } = await caller.auth.getUser(jwt);
  if (callerErr || !callerData.user) {
    return json(401, { error: "Invalid session. Please sign in again." });
  }
  const callerAuthId = callerData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Role read SERVER-SIDE from the caller's OWN users row -- never from
  // anything the client sends. Literal "owner/manager" per spec (not
  // the broader owner/admin/manager/dispatcher quartet used elsewhere
  // in this app for similar manager-tier gates) -- flagging this choice
  // in the PR description in case admin/dispatcher should also be able
  // to send invites.
  const callerRow = await admin.from("users").select("business_id, role").eq("id", callerAuthId).maybeSingle();
  const callerBusinessId = callerRow.data?.business_id;
  if (!callerBusinessId) return json(403, { error: "No tenant for caller" });
  const callerRole = callerRow.data?.role;
  if (callerRole !== "owner" && callerRole !== "manager") {
    return json(403, { error: "Only an owner or manager can send invites." });
  }

  let payload: { employee_id?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const employeeId = payload.employee_id;
  if (!employeeId || typeof employeeId !== "string") {
    return json(400, { error: "Missing employee_id" });
  }

  // Rate limits (defense in depth) -- checked before any write.
  const employeeRateKey = `invite:employee:${employeeId}`;
  const callerRateKey = `invite:caller:${callerAuthId}`;
  const empCheck = await admin.rpc("rate_limit_check", { p_key: employeeRateKey, p_max: 5, p_window_seconds: 3600 });
  if (empCheck.error) {
    console.error("[send-invite] rate_limit_check (employee) failed:", empCheck.error);
  } else if (empCheck.data === false) {
    return json(429, { error: "Too many invites sent to this person recently. Try again later." });
  }
  const callerCheck = await admin.rpc("rate_limit_check", { p_key: callerRateKey, p_max: 100, p_window_seconds: 3600 });
  if (callerCheck.error) {
    console.error("[send-invite] rate_limit_check (caller) failed:", callerCheck.error);
  } else if (callerCheck.data === false) {
    return json(429, { error: "Rate limit reached -- try again in a few minutes." });
  }

  const { data: employee, error: empErr } = await admin
    .from("employees")
    .select("id, business_id, first_name, phone")
    .eq("id", employeeId)
    .maybeSingle();
  if (empErr || !employee) return json(404, { error: "Employee not found." });
  if (employee.business_id !== callerBusinessId) {
    return json(403, { error: "Not authorized for this employee." });
  }

  const normalized = normalizePhone((employee.phone as unknown as string) || "");
  if (!normalized) {
    return json(400, { error: "No phone number on file for this employee. Add one in the Staff edit form first." });
  }

  // Invite-collision guard: runs before any text is sent, and before
  // the invite row is even created -- a blocked invite leaves nothing
  // behind for accept-invite to fail on later. Never logs or returns
  // a phone number; employee ids only.
  {
    const { data: allEmployees, error: collisionQueryErr } = await admin
      .from("employees")
      .select("id, first_name, last_name, phone, email, auth_user_id")
      .eq("business_id", callerBusinessId);
    if (collisionQueryErr) {
      console.error("[send-invite] collision check query failed for employee", employeeId, ":", collisionQueryErr.message);
      return json(500, { error: "Could not check for a phone-number conflict. Try again." });
    }
    const collision = findPhoneCollision(employeeId, normalized, allEmployees || []);
    if (collision) {
      const otherName = [collision.first_name, collision.last_name].filter(Boolean).join(" ").trim() || "another employee";
      console.error("[send-invite] phone_already_registered: employee", employeeId, "collides with employee", collision.id);
      return json(409, {
        error: `This phone number is already registered to ${otherName}'s account. Correct the phone number in Staff first.`,
        error_code: "phone_already_registered",
      });
    }
  }

  const { data: bizRow } = await admin.from("businesses").select("name").eq("id", callerBusinessId).maybeSingle();
  const businessName = (bizRow && bizRow.name) || "Penta";

  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const { error: insertErr } = await admin.from("employee_invites").insert({
    business_id: callerBusinessId,
    employee_id: employeeId,
    token,
    phone_sent_to: employee.phone,
    expires_at: expiresAt,
  });
  if (insertErr) {
    console.error("[send-invite] employee_invites insert failed:", insertErr.message);
    return json(500, { error: "Could not create the invite. Try again." });
  }

  const link = `https://captainclean115-oss.github.io/cleaningapp/accept-invite.html?token=${token}`;
  const firstName = (employee.first_name as unknown as string) || "there";
  const text = `Hi ${firstName}, ${businessName} set up your Penta account. Create your password here: ${link}`;

  const sent = await sendInviteText(admin, callerBusinessId, normalized, text);
  if (!sent) {
    return json(502, { error: "Could not send the text. The invite was created -- use Copy invite link, or try Resend." });
  }

  await admin.rpc("rate_limit_increment", { p_key: employeeRateKey, p_window_seconds: 3600 });
  await admin.rpc("rate_limit_increment", { p_key: callerRateKey, p_window_seconds: 3600 });

  return json(200, { success: true });
});
