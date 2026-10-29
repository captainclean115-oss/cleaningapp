#!/usr/bin/env python3
"""Claire portal-links feature, step 2: add a 'reset' action to the
existing send-invite Edge Function (NOT deployed by this script -- see
the PR description for the exact deploy command). Preferred approach
from Step 0 Q4: reuse send-invite's existing manager/owner auth check
and rate-limit pattern, branch on a new optional `action` field
('invite' default, or 'reset'), and for 'reset' generate a Supabase
recovery link (the same admin.auth.admin.generateLink({type:'recovery'})
call request-password-reset already uses) instead of a new
employee_invites token row. Never logs or returns the link itself,
exactly like the existing invite path.

_apply_edits.py's apply_edits() is hardcoded to index.html -- this file
reimplements the same "assert exactly one occurrence before replacing"
discipline for an arbitrary path instead of importing that module.
"""

TS_PATH = "supabase/functions/send-invite/index.ts"


def replace_once(content, old, new, label):
    count = content.count(old)
    if count == 0:
        raise SystemExit(f"FAIL [{label}]: old string not found at all")
    if count > 1:
        raise SystemExit(f"FAIL [{label}]: old string found {count} times (expected exactly 1)")
    return content.replace(old, new, 1)


HEADER_OLD = '''// Edge Function: send-invite
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
// per hour (same per-user ceiling send-sms already uses).'''

HEADER_NEW = '''// Edge Function: send-invite
// Caller: a real owner/manager JWT is required (this is NOT a public
// endpoint like accept-invite/phone-login/request-password-reset --
// sending an invite is a manager action, not something a not-yet-
// invited employee or an anonymous caller can ever trigger).
// Deploy with: supabase functions deploy send-invite --project-ref wymoezilyjmyibmuqqmr
//
// Input: { employee_id, action? } -- action is "invite" (default, for
// backward compatibility: every existing caller never sends this field
// at all) or "reset". Never accepts a client-supplied phone number or
// message text for EITHER action -- both are always resolved/built
// server-side from the employee's own row and a fixed template, so a
// compromised or buggy client can't make this function text an
// arbitrary number or an arbitrary message.
//
// action="invite" (unchanged): generates a fresh invite token +
// employee_invites row (same shape pentaSendInvite's client-side code
// used to write), builds the fixed-template text, and sends it via the
// business's own RingCentral integration -- the SAME sender logic
// request-password-reset's sendResetText uses (copied here, not
// re-derived differently, so the two Edge Functions' RC-calling
// behavior can't drift apart).
//
// action="reset" (Claire portal-links feature): for an employee who
// ALREADY has a login (auth_user_id set -- checked server-side, not
// trusted from the client), generates a single-use Supabase recovery
// link the SAME way request-password-reset already does
// (admin.auth.admin.generateLink({type:"recovery", ...})) and texts it.
// No employee_invites row is written for a reset -- Supabase's own
// recovery-link mechanism already handles single-use + expiry natively,
// exactly like request-password-reset's existing flow. The link's
// actual expiry window is a Supabase project Auth setting (Dashboard ->
// Authentication), the same one already requested when phone login
// shipped -- confirm it's set to 60 minutes before relying on this.
//
// Returns ONLY { success: true } or { error: <plain reason> } for
// EITHER action -- never the phone number, the message, the link, or
// the token, to the caller OR to any console.log. A manager who needs
// the actual INVITE link (e.g. the SMS send failed and she wants a
// fallback) reads it a SEPARATE way: employee_invites.token is already
// readable by her own RLS-scoped client session (emp_invites_select
// policy: owner/admin/manager), so the Staff screen's own "Copy invite
// link" button queries that table directly -- this function doesn't
// need to expose the token for that to work. There is no equivalent
// fallback for a reset link (nothing is stored for it) -- a failed
// reset send just needs to be retried.
//
// Rate limit (defense in depth, same generic RPCs every other Edge
// Function in this app uses): 5 per employee per hour per action (stops
// a client-side bug from spamming one person with texts), 100 per
// caller per hour per action (same per-user ceiling send-sms already
// uses). Invite and reset rate-limit keys are separate -- sending one
// doesn't eat into the other's budget.'''

PAYLOAD_OLD = '''  let payload: { employee_id?: string };
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
});'''

PAYLOAD_NEW = '''  let payload: { employee_id?: string; action?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const employeeId = payload.employee_id;
  if (!employeeId || typeof employeeId !== "string") {
    return json(400, { error: "Missing employee_id" });
  }
  // Default "invite" preserves exact backward compatibility -- every
  // existing caller (Staff screen Send/Resend/Bulk, Claire's
  // send_portal_invite) never sends this field at all.
  const action = payload.action === "reset" ? "reset" : "invite";

  // Rate limits (defense in depth) -- checked before any write. Invite
  // and reset keys are deliberately separate so one action's volume
  // never eats into the other's budget.
  const employeeRateKey = `${action}:employee:${employeeId}`;
  const callerRateKey = `${action}:caller:${callerAuthId}`;
  const empCheck = await admin.rpc("rate_limit_check", { p_key: employeeRateKey, p_max: 5, p_window_seconds: 3600 });
  if (empCheck.error) {
    console.error(`[send-invite:${action}] rate_limit_check (employee) failed:`, empCheck.error);
  } else if (empCheck.data === false) {
    return json(429, { error: `Too many ${action === "reset" ? "resets" : "invites"} sent to this person recently. Try again later.` });
  }
  const callerCheck = await admin.rpc("rate_limit_check", { p_key: callerRateKey, p_max: 100, p_window_seconds: 3600 });
  if (callerCheck.error) {
    console.error(`[send-invite:${action}] rate_limit_check (caller) failed:`, callerCheck.error);
  } else if (callerCheck.data === false) {
    return json(429, { error: "Rate limit reached -- try again in a few minutes." });
  }

  const { data: employee, error: empErr } = await admin
    .from("employees")
    .select("id, business_id, first_name, phone, email, auth_user_id")
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

  const { data: bizRow } = await admin.from("businesses").select("name").eq("id", callerBusinessId).maybeSingle();
  const businessName = (bizRow && bizRow.name) || "Penta";
  const firstName = (employee.first_name as unknown as string) || "there";

  if (action === "reset") {
    // Server-side check, not trusted from the client: a reset only ever
    // makes sense for an employee who ALREADY has a login. This mirrors
    // (does not duplicate) the same eligibility rule Claire's
    // send_password_reset_link tool checks client-side before ever
    // calling here -- both exist so neither side has to trust the other.
    if (!employee.auth_user_id) {
      return json(409, { error: "This employee doesn't have a login yet. Send an invite instead." });
    }
    const email = employee.email as unknown as string;
    if (!email) {
      return json(500, { error: "No login email on file for this employee." });
    }

    const linkRes = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: "https://captainclean115-oss.github.io/cleaningapp/reset.html" },
    });
    if (linkRes.error || !linkRes.data?.properties?.action_link) {
      console.error("[send-invite:reset] generateLink failed (detail redacted from log)");
      return json(500, { error: "Could not create the reset link. Try again." });
    }
    const resetLink = linkRes.data.properties.action_link;
    const resetText = `Hi ${firstName}, ${businessName} received a request to reset your Penta password. Reset here: ${resetLink}`;

    const resetSent = await sendInviteText(admin, callerBusinessId, normalized, resetText);
    if (!resetSent) {
      return json(502, { error: "Could not send the text. Try again." });
    }

    await admin.rpc("rate_limit_increment", { p_key: employeeRateKey, p_window_seconds: 3600 });
    await admin.rpc("rate_limit_increment", { p_key: callerRateKey, p_window_seconds: 3600 });
    return json(200, { success: true });
  }

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
  const text = `Hi ${firstName}, ${businessName} set up your Penta account. Create your password here: ${link}`;

  const sent = await sendInviteText(admin, callerBusinessId, normalized, text);
  if (!sent) {
    return json(502, { error: "Could not send the text. The invite was created -- use Copy invite link, or try Resend." });
  }

  await admin.rpc("rate_limit_increment", { p_key: employeeRateKey, p_window_seconds: 3600 });
  await admin.rpc("rate_limit_increment", { p_key: callerRateKey, p_window_seconds: 3600 });

  return json(200, { success: true });
});'''

if __name__ == "__main__":
    with open(TS_PATH, "r", encoding="utf-8") as f:
        content = f.read()
    content = replace_once(content, HEADER_OLD, HEADER_NEW, "send-invite header comment: document reset action")
    print("  ok   send-invite header comment: document reset action")
    content = replace_once(content, PAYLOAD_OLD, PAYLOAD_NEW, "send-invite: add reset action branch")
    print("  ok   send-invite: add reset action branch")
    with open(TS_PATH, "w", encoding="utf-8") as f:
        f.write(content)
    print("Applied 2 edit(s) to " + TS_PATH)
