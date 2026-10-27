// Edge Function: repair-login-email
// Owner/admin-only. Moves an existing employee's AUTH login email to
// the email derived from her CURRENT phone number, keeping her
// password and auth user id untouched.
//
// Why this is needed: accept-invite's own "employee already has a
// login" branch only ever calls
// admin.auth.admin.updateUserById(authUserId, { password }) -- it
// never re-derives or updates her email. So if her phone is corrected
// AFTER her first invite acceptance, every later invite/reset cycle
// just resets her password and leaves her auth email permanently
// stuck on whatever phone she had at that very first acceptance.
// There was previously no tool to fix that drift without touching
// auth.users directly by hand.
//
// Deploy with: supabase functions deploy repair-login-email --project-ref wymoezilyjmyibmuqqmr
// (verify-jwt ON -- the default. Unlike accept-invite/phone-login,
// which are public by design, this is a sensitive, owner/admin-only
// write and needs a real caller session.)
//
// Never logs or returns a phone number, token, or link. Logs use
// employee ids only. Every response uses email DOMAIN SUFFIXES ONLY
// (e.g. "@phone.penta.internal"), never the local part -- for a
// phone-derived address, the local part IS the phone number.

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

// Same normalization rule send-invite/accept-invite/phone-login all
// use, copied verbatim -- not re-derived differently. Edge Functions
// in this project deploy independently, so there is no shared module
// to import across them; copying the identical, already-tested logic
// IS "sharing" it, in the only way actually possible here.
function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function derivePhoneEmail(normalizedPhone: string): string {
  return `${normalizedPhone}@phone.penta.internal`;
}

function emailSuffix(email: string | null | undefined): string {
  if (!email) return "(none)";
  const at = email.indexOf("@");
  return at === -1 ? "(no @)" : email.slice(at);
}

function maskPhone(normalizedPhone: string): string {
  return "***-***-" + normalizedPhone.slice(-4);
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

  // Role read SERVER-SIDE from the caller's OWN users row -- never
  // from the request payload. Owner/admin only -- stricter than
  // send-invite's owner/manager gate, since this writes directly to
  // auth.users.
  const callerRow = await admin.from("users").select("business_id, role").eq("id", callerAuthId).maybeSingle();
  const callerBusinessId = callerRow.data?.business_id;
  if (!callerBusinessId) return json(403, { error: "No tenant for caller" });
  const callerRole = callerRow.data?.role;
  if (callerRole !== "owner" && callerRole !== "admin") {
    return json(403, { error: "Only an owner or admin can repair a login email." });
  }

  let payload: { employee_id?: string; dry_run?: boolean };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const employeeId = payload.employee_id;
  if (!employeeId || typeof employeeId !== "string") {
    return json(400, { error: "Missing employee_id" });
  }
  // Defaults to a dry run -- must be EXPLICITLY false to write anything.
  const dryRun = payload.dry_run !== false;

  const { data: employee, error: empErr } = await admin
    .from("employees")
    .select("id, business_id, first_name, last_name, phone, email, auth_user_id, status")
    .eq("id", employeeId)
    .maybeSingle();
  if (empErr || !employee) return json(404, { error: "Employee not found." });
  if (employee.business_id !== callerBusinessId) {
    return json(403, { error: "Not authorized for this employee." });
  }
  if (!employee.auth_user_id) {
    return json(400, { error: "This employee has no login yet -- nothing to repair." });
  }
  if (employee.status === "terminated") {
    return json(400, { error: "This employee is terminated -- her login is not repaired." });
  }
  const normalized = normalizePhone((employee.phone as unknown as string) || "");
  if (!normalized) {
    return json(400, { error: "No valid phone number on file for this employee. Correct it in Staff first." });
  }
  const targetEmail = derivePhoneEmail(normalized);
  const authUserId = employee.auth_user_id as unknown as string;

  const { data: authUserRes, error: getUserErr } = await admin.auth.admin.getUserById(authUserId);
  if (getUserErr || !authUserRes?.user) {
    console.error("[repair-login-email] could not load auth user for employee", employeeId, ":", getUserErr?.message);
    return json(500, { error: "Could not load this employee's login. Try again." });
  }
  const currentAuthEmail = authUserRes.user.email || null;

  if (currentAuthEmail === targetEmail) {
    return json(200, { status: "already_correct" });
  }

  // Collision check against the REAL auth.users email (not
  // employees.email, which can already be stale/corrected while the
  // auth account itself still isn't -- exactly the drift this
  // function exists to fix). listUsers() + an in-memory filter is the
  // only way the admin API exposes an email lookup without risking a
  // real email ending up as a query-string parameter somewhere
  // outside our control; this business is small enough (well under
  // 1000 accounts) for one page to cover everyone.
  const { data: listRes, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) {
    console.error("[repair-login-email] listUsers failed for employee", employeeId, ":", listErr.message);
    return json(500, { error: "Could not check for a conflicting login. Try again." });
  }
  const collidingUser = (listRes?.users || []).find((u) => u.email === targetEmail && u.id !== authUserId);
  if (collidingUser) {
    const { data: collidingEmp } = await admin
      .from("employees")
      .select("first_name, last_name")
      .eq("business_id", callerBusinessId)
      .eq("auth_user_id", collidingUser.id)
      .maybeSingle();
    const otherName = collidingEmp
      ? ([collidingEmp.first_name, collidingEmp.last_name].filter(Boolean).join(" ").trim() || "another employee")
      : "another account";
    console.error("[repair-login-email] target email collides with another auth user, for employee", employeeId);
    return json(409, {
      error: `This phone number's login email is already registered to ${otherName}'s account. Correct the phone number in Staff first.`,
      error_code: "target_email_taken",
    });
  }

  if (dryRun) {
    return json(200, {
      status: "would_change",
      old_email_suffix: emailSuffix(currentAuthEmail),
      new_email_suffix: emailSuffix(targetEmail),
      phone_masked: maskPhone(normalized),
    });
  }

  // Real run. NO password field here, ever -- this must never touch it.
  const { error: updateAuthErr } = await admin.auth.admin.updateUserById(authUserId, {
    email: targetEmail,
    email_confirm: true,
  });
  if (updateAuthErr) {
    console.error("[repair-login-email] updateUserById(email) failed for employee", employeeId, ":", updateAuthErr.message);
    return json(500, { error: "Could not update the login email. Nothing was changed." });
  }

  const { error: updateEmpErr } = await admin.from("employees").update({ email: targetEmail }).eq("id", employeeId);
  if (updateEmpErr) {
    console.error("[repair-login-email] employees.email update FAILED after the auth email already changed, for employee", employeeId, ":", updateEmpErr.message, "-- attempting rollback");
    const { error: rollbackErr } = await admin.auth.admin.updateUserById(authUserId, {
      email: currentAuthEmail as string,
      email_confirm: true,
    });
    if (rollbackErr) {
      console.error("[repair-login-email] ROLLBACK ALSO FAILED for employee", employeeId, ":", rollbackErr.message);
      return json(500, {
        error: "Critical: the login email was changed but the employee record update failed, and the rollback also failed. This needs manual attention.",
      });
    }
    return json(500, {
      error: "Could not finish the repair -- the login email change was rolled back. Nothing was changed.",
    });
  }

  // Supplementary audit row -- best-effort, same pattern
  // update_my_employee_profile already uses (source tag + old/new
  // values, never blocks the actual write). Suffixes only.
  try {
    await admin.from("audit_log").insert({
      business_id: callerBusinessId,
      user_id: callerAuthId,
      action_type: "manual_note",
      entity_type: "employee",
      entity_id: employeeId,
      new_values: {
        source: "login_email_repair",
        old_email_suffix: emailSuffix(currentAuthEmail),
        new_email_suffix: emailSuffix(targetEmail),
      },
    });
  } catch (e) {
    console.error("[repair-login-email] audit_log insert failed (non-fatal) for employee", employeeId, ":", (e as Error).message);
  }

  return json(200, {
    status: "repaired",
    old_email_suffix: emailSuffix(currentAuthEmail),
    new_email_suffix: emailSuffix(targetEmail),
  });
});
