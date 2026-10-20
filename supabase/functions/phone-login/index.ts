// Edge Function: phone-login
// Public endpoint (no JWT -- this IS how she logs in, she has no session yet).
// Deploy with: supabase functions deploy phone-login --project-ref wymoezilyjmyibmuqqmr --no-verify-jwt
//
// Employee-facing "sign in with phone number" path. The manager's own
// email+password login (#penta-login-screen / PentaAuth.signIn) is
// completely untouched -- this is an ADDITIONAL path, not a replacement.
//
// Why this needs to be server-side at all (not just "compute the email
// client-side and call signInWithPassword directly"): the auth email on
// file for an employee is NOT reliably derivable from her phone number --
// the 5 already-linked employees (Blanca, Melissa, Nadia, Tomas, Viviana)
// have the OLD firstname.lastname@employees.penta.internal placeholder,
// while new invites (accept-invite, updated in this same PR) will start
// using <10digits>@phone.penta.internal. Only a server-side lookup on
// employees.phone (which requires elevated privilege -- an anonymous,
// not-yet-authenticated caller can't read the employees table under RLS)
// can resolve "whichever email is actually on file" for either shape, so
// the same phone+password always works regardless of when she was
// invited.
//
// Confirmed live (read-only query, 2026-10-20): two currently-active
// employees, Blanca Payan and Viviana, normalize to the SAME 10-digit
// phone number. Rather than silently pick one, this function tries
// EVERY active employee row that matches the normalized phone against
// the given password (via the regular, unprivileged signInWithPassword
// call -- never a privileged bypass) and returns whichever one's
// password actually matches. If two people share a number, each still
// only gets in with HER OWN password.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

// Same normalization rule the client, the invite flow, and the Staff
// screen's duplicate check all use: strip everything but digits, drop a
// leading US country code "1" if the result is 11 digits.
function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  if (digits.length === 10) return digits;
  return null; // not a valid 10-digit US number -- never attempt a lookup
}

// ALWAYS the same message, whether the phone doesn't exist, the password
// is wrong, or anything else fails -- never reveals which. Logging
// (below) is for operator debugging only, never returned to the caller.
const GENERIC_INVALID = "Invalid phone number or password.";
const LOCKOUT_MSG = "Too many attempts. Try again in a few minutes.";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let payload: { phone?: string; password?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const rawPhone = payload.phone;
  const password = payload.password;
  if (!rawPhone || typeof rawPhone !== "string") return json(400, { error: "Missing phone" });
  if (!password || typeof password !== "string") return json(400, { error: GENERIC_INVALID });

  const normalized = normalizePhone(rawPhone);
  // An unparseable phone can never match a real employee -- but still run
  // it through the SAME generic-failure path (don't short-circuit with a
  // different message), so the response shape is identical either way.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Lockout check BEFORE any lookup or password attempt -- 5 failed
  // attempts per phone per 15 minutes. Keyed on the RAW input (not the
  // normalized form) when normalization failed, so repeated garbage
  // input still gets rate-limited instead of bypassing the check.
  const lockoutKey = `login:phone:${normalized || rawPhone}`;
  const lockoutCheck = await admin.rpc("rate_limit_check", {
    p_key: lockoutKey, p_max: 5, p_window_seconds: 900,
  });
  if (lockoutCheck.error) {
    console.error("[phone-login] rate_limit_check failed:", lockoutCheck.error);
    // Fail OPEN on a rate-limiter malfunction -- same convention as
    // send-sms: a transient DB issue must not lock everyone out.
  } else if (lockoutCheck.data === false) {
    return json(429, { error: LOCKOUT_MSG });
  }

  async function fail(): Promise<Response> {
    try {
      await admin.rpc("rate_limit_increment", { p_key: lockoutKey, p_window_seconds: 900 });
    } catch (e) {
      console.error("[phone-login] rate_limit_increment failed (non-fatal):", e);
    }
    return json(401, { error: GENERIC_INVALID });
  }

  if (!normalized) return await fail();

  const { data: matches, error: lookupErr } = await admin
    .from("employees")
    .select("id, email, status")
    .eq("status", "active")
    .not("phone", "is", null);
  if (lookupErr) {
    console.error("[phone-login] employees lookup failed:", lookupErr);
    return json(500, { error: "Could not sign in right now. Please try again." });
  }

  // Filtered in JS (not SQL) -- same reasoning as send-sms's
  // additional_phones scan: comparing a regexp_replace'd expression
  // against a parameter isn't indexable or reliably portable across
  // formats stored with varying punctuation, and this business has ~25
  // employees, not a volume where this matters.
  const candidates = (matches || []).filter((e) => normalizePhone(e.phone as unknown as string) === normalized);
  if (!candidates.length) return await fail();

  // Try each matching employee's own email+password. A REGULAR
  // (anon-key) client call -- never a privileged bypass -- so this can
  // never succeed without the real password for that specific account.
  const anonForLogin = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const emp of candidates) {
    if (!emp.email) continue;
    const { data: signInData, error: signInErr } = await anonForLogin.auth.signInWithPassword({
      email: emp.email as unknown as string,
      password,
    });
    if (!signInErr && signInData.session) {
      // Success resets nothing explicitly -- rate_limit_check's own
      // sliding window ages out on its own; a real employee locked out
      // by her own earlier typos still has to wait out the window even
      // after getting it right, same as the window naturally expiring.
      return json(200, {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
        expires_at: signInData.session.expires_at,
      });
    }
  }

  return await fail();
});
