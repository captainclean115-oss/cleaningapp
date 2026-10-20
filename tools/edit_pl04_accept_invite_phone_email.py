#!/usr/bin/env python3
"""Phone + password login feature. accept-invite now computes a
deterministic, collision-resistant email from the employee's PHONE
(<10digits>@phone.penta.internal) for a brand-new auth account, instead
of the old name-based slug -- two employees with the same name could
otherwise collide; two different 10-digit phone numbers cannot. Only
affects NEW accounts (the `if (!authUserId)` branch) -- the 5 already-
linked employees keep whatever email they already have untouched, since
this file's `else` branch (just updating the password) never reads or
writes email at all. Falls back to the existing employees.email if no
usable phone is on file, so this never breaks for someone without one
(they just can't use phone login -- a separate invite-time check, not
this function's job to enforce).
"""
import sys

PATH = "supabase/functions/accept-invite/index.ts"

with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()

OLD = """  const { data: employee, error: empErr } = await admin
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
  } else {"""

NEW = """  const { data: employee, error: empErr } = await admin
    .from("employees")
    .select("id, business_id, email, phone, first_name, last_name, auth_user_id")
    .eq("id", invite.employee_id)
    .maybeSingle();

  if (empErr || !employee) return json(500, { error: "Employee record missing" });

  let authUserId = employee.auth_user_id;

  // Phone + password login feature: a brand-new account gets a phone-
  // derived email (<10digits>@phone.penta.internal) instead of the old
  // name-based slug, so two employees who happen to share a name can
  // never collide -- two different 10-digit numbers can't either. Falls
  // back to whatever's already in employees.email if no usable 10-digit
  // US phone is on file.
  function phoneDerivedEmail(raw: unknown): string | null {
    const digits = String(raw || "").replace(/\\D/g, "");
    const ten = digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
    if (ten.length !== 10) return null;
    return `${ten}@phone.penta.internal`;
  }
  const newAccountEmail = !authUserId ? (phoneDerivedEmail(employee.phone) || employee.email) : employee.email;

  if (!authUserId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: newAccountEmail,
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

    // Persist the SAME email the auth account actually got -- phone-login
    // reads employees.email to resolve who to sign in, so these two must
    // never drift apart. email_is_internal=true matches this app's
    // existing convention for a synthetic (non-deliverable) address.
    const { error: linkErr } = await admin
      .from("employees")
      .update({ auth_user_id: authUserId, status: "active", email: newAccountEmail, email_is_internal: true })
      .eq("id", employee.id);
    if (linkErr) return json(500, { error: "Failed to link employee", detail: linkErr.message });
  } else {"""

count = content.count(OLD)
if count != 1:
    raise SystemExit(f"FAIL: expected exactly 1 occurrence, found {count}")
content = content.replace(OLD, NEW, 1)

with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)
print("Applied edit to", PATH)
