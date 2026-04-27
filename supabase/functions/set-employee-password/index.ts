// Edge Function: set-employee-password
// Manager-only endpoint. Caller must have a valid JWT for an owner/admin/manager
// in the same business as the target employee.
// Deploy with: supabase functions deploy set-employee-password --project-ref wymoezilyjmyibmuqqmr
//
// Sets a temporary password and flips app_metadata.must_change_password=true so
// the next time the employee signs in, the boot router forces a password change
// before either app loads.

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // 1. Verify caller has a valid JWT.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Missing Authorization header" });

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerData.user) return json(401, { error: "Invalid JWT" });

  const callerId = callerData.user.id;

  // 2. Look up caller's role + business via the admin client.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: callerUser, error: callerUserErr } = await admin
    .from("users")
    .select("id, business_id, role")
    .eq("id", callerId)
    .maybeSingle();

  if (callerUserErr || !callerUser) return json(403, { error: "Caller not found in users table" });
  if (!["owner", "admin", "manager"].includes(callerUser.role)) {
    return json(403, { error: "Insufficient role" });
  }

  // 3. Parse payload.
  let payload: { employee_id?: string; temp_password?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { employee_id, temp_password } = payload;
  if (!employee_id) return json(400, { error: "Missing employee_id" });
  if (!temp_password || temp_password.length < 8) {
    return json(400, { error: "Password must be at least 8 characters" });
  }

  // 4. Look up target employee + same-business check.
  const { data: emp, error: empErr } = await admin
    .from("employees")
    .select("id, business_id, email, first_name, last_name, auth_user_id")
    .eq("id", employee_id)
    .maybeSingle();
  if (empErr || !emp) return json(404, { error: "Employee not found" });
  if (emp.business_id !== callerUser.business_id) {
    return json(403, { error: "Cross-tenant operation blocked" });
  }

  let authUserId = emp.auth_user_id;

  // 5. Create or update auth.users row, set must_change_password flag.
  if (!authUserId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: emp.email,
      password: temp_password,
      email_confirm: true,
      user_metadata: {
        first_name: emp.first_name,
        last_name: emp.last_name,
        business_id: emp.business_id,
        is_employee: true,
      },
      app_metadata: { must_change_password: true },
    });
    if (createErr || !created.user) {
      return json(500, { error: "Failed to create auth user", detail: createErr?.message });
    }
    authUserId = created.user.id;

    const { error: linkErr } = await admin
      .from("employees")
      .update({ auth_user_id: authUserId, status: "active" })
      .eq("id", emp.id);
    if (linkErr) return json(500, { error: "Failed to link employee", detail: linkErr.message });

    const { error: pubUserErr } = await admin.from("users").upsert(
      {
        id: authUserId,
        auth_user_id: authUserId,
        business_id: emp.business_id,
        role: "employee",
        email: emp.email,
        first_name: emp.first_name,
        last_name: emp.last_name,
      },
      { onConflict: "id" }
    );
    if (pubUserErr) {
      console.error("public.users upsert FAILED:", pubUserErr);
      return json(500, { error: "Failed to create users record", detail: pubUserErr.message, code: pubUserErr.code });
    }
  } else {
    const { error: updErr } = await admin.auth.admin.updateUserById(authUserId, {
      password: temp_password,
      app_metadata: { must_change_password: true },
    });
    if (updErr) return json(500, { error: "Failed to update password", detail: updErr.message });
  }

  return json(200, { success: true, email: emp.email });
});
