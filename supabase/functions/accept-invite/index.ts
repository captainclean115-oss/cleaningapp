// Edge Function: accept-invite
// Public endpoint (no JWT verification — token IS the credential).
// Deploy with: supabase functions deploy accept-invite --project-ref wymoezilyjmyibmuqqmr --no-verify-jwt
//
// Called by /accept-invite.html with { token, password }.
// Validates the invite token, creates the auth.users row, links to employees,
// upserts the public.users row, marks the invite accepted.
//
// v9.6.1: handle the case where v9.6's manager-hire flow pre-inserted a
// public.users row with role='manager'. Without this, the upsert below
// hardcoded role='employee' AND the pre-existing row's auto-generated id
// didn't match the new authUserId — so the upsert tried to INSERT and
// collided on email/business unique. Now we look up the pre-existing row
// first, preserve role + manager_permissions, and delete the orphan so
// the auth-keyed row can land cleanly.

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let payload: { token?: string; password?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { token, password } = payload;
  if (!token || typeof token !== "string") return json(400, { error: "Missing token" });
  if (!password || typeof password !== "string" || password.length < 8) {
    return json(400, { error: "Password must be at least 8 characters" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: invite, error: inviteErr } = await admin
    .from("employee_invites")
    .select("id, business_id, employee_id, expires_at, accepted_at, revoked_at")
    .eq("token", token)
    .maybeSingle();

  if (inviteErr) {
    console.error('[accept-invite] invite lookup failed:', JSON.stringify(inviteErr));
    return json(500, { error: "DB error looking up invite", detail: inviteErr.message, code: inviteErr.code });
  }
  if (!invite) return json(404, { error: "Invite not found" });
  if (invite.revoked_at) return json(410, { error: "Invite revoked" });
  if (invite.accepted_at) return json(409, { error: "Invite already used" });
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return json(410, { error: "Invite expired" });
  }

  const { data: employee, error: empErr } = await admin
    .from("employees")
    .select("id, business_id, email, first_name, last_name, auth_user_id")
    .eq("id", invite.employee_id)
    .maybeSingle();

  if (empErr || !employee) return json(500, { error: "Employee record missing" });

  let authUserId = employee.auth_user_id;

  if (!authUserId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: employee.email,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: employee.first_name,
        last_name: employee.last_name,
        business_id: employee.business_id,
        is_employee: true,
      },
    });
    if (createErr || !created.user) {
      return json(500, { error: "Failed to create auth user", detail: createErr?.message });
    }
    authUserId = created.user.id;

    const { error: linkErr } = await admin
      .from("employees")
      .update({ auth_user_id: authUserId, status: "active" })
      .eq("id", employee.id);
    if (linkErr) return json(500, { error: "Failed to link employee", detail: linkErr.message });
  } else {
    const { error: updErr } = await admin.auth.admin.updateUserById(authUserId, { password });
    if (updErr) return json(500, { error: "Failed to update password", detail: updErr.message });
  }

  // v9.6.1: look for a pre-existing public.users row created by the
  // manager-hire flow (saveStaffEmployee inserts one at hire-time with
  // role='manager' + an auto-generated id, before the invitee has an
  // auth user). Preserve role + manager_permissions; delete the orphan
  // so the auth-keyed upsert below can land without collisions.
  let preserveRole: string = "employee";
  let preservePerms: Record<string, unknown> = {};
  try {
    const { data: pre } = await admin
      .from("users")
      .select("id, role, manager_permissions")
      .eq("business_id", employee.business_id)
      .ilike("email", employee.email)
      .maybeSingle();
    if (pre) {
      if (pre.role === "manager" || pre.role === "admin" || pre.role === "owner") {
        preserveRole = pre.role as string;
        preservePerms = (pre.manager_permissions as Record<string, unknown>) || {};
      }
      if (pre.id !== authUserId) {
        // Orphan row from v9.6 pre-insert. Delete it; the upsert below
        // recreates the row keyed by authUserId with preserved role.
        const { error: delErr } = await admin.from("users").delete().eq("id", pre.id);
        if (delErr) {
          console.error("[accept-invite] pre-row delete failed:", JSON.stringify(delErr));
          // Non-fatal — try the upsert anyway. Worst case, the upsert
          // collides and we surface that error to the caller.
        }
      }
    }
  } catch (e) {
    console.error("[accept-invite] pre-row lookup threw:", e);
    // Continue to upsert — preserveRole defaults to 'employee'.
  }

  const { error: pubUserErr } = await admin
    .from("users")
    .upsert(
      {
        id: authUserId,
        auth_user_id: authUserId,
        business_id: employee.business_id,
        role: preserveRole,
        email: employee.email,
        first_name: employee.first_name,
        last_name: employee.last_name,
        ...(preserveRole === "manager" ? { manager_permissions: preservePerms } : {}),
      },
      { onConflict: "id" }
    );
  if (pubUserErr) {
    console.error("public.users upsert FAILED:", pubUserErr);
    return json(500, { error: "Failed to create users record", detail: pubUserErr.message, code: pubUserErr.code });
  }

  const { error: acceptErr } = await admin
    .from("employee_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id);
  if (acceptErr) return json(500, { error: "Failed to mark invite accepted" });

  return json(200, { success: true, email: employee.email });
});
