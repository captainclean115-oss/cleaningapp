#!/usr/bin/env python3
"""Invite-collision guard, step 1: send-invite's server-side pre-check.

Root cause: a phone number can be shared across multiple employee rows
(any status, including terminated fixture rows). The first employee
who ever accepts an invite under that number permanently claims the
phone-derived login email (<10digits>@phone.penta.internal) in
auth.users -- employees.email is set once at that moment and never
re-synced if the phone changes later. Today nothing catches this
before the SMS goes out: the ONLY existing duplicate-phone guard
(client-side, in pentaSendInvite) only compares ACTIVE employees'
CURRENT phones against each other, so it can't see a stale, already-
registered identity on a terminated or otherwise-changed row.

Fix: before creating the invite or sending any text, check every OTHER
employee row in the same business (any status) for one that already
has a login (auth_user_id set) AND whose stored email or current phone
matches this phone. If found, refuse with a named, actionable message
and error_code 'phone_already_registered' -- never silently proceed
to a text that can only fail later at accept-invite.

findPhoneCollision/derivePhoneEmail are pure (no I/O, no Deno APIs) so
they can be extracted and unit-tested directly from this file, same as
normalizePhone already was testable in isolation.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import replace_once

PATH = "supabase/functions/send-invite/index.ts"

OLD_NORMALIZE = """function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}"""

NEW_NORMALIZE = """function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\\D/g, "");
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
}"""

OLD_CHECK_SITE = """  const normalized = normalizePhone((employee.phone as unknown as string) || "");
  if (!normalized) {
    return json(400, { error: "No phone number on file for this employee. Add one in the Staff edit form first." });
  }

  const { data: bizRow } = await admin.from("businesses").select("name").eq("id", callerBusinessId).maybeSingle();"""

NEW_CHECK_SITE = """  const normalized = normalizePhone((employee.phone as unknown as string) || "");
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

  const { data: bizRow } = await admin.from("businesses").select("name").eq("id", callerBusinessId).maybeSingle();"""

with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()
content = replace_once(content, OLD_NORMALIZE, NEW_NORMALIZE, "normalizePhone: add derivePhoneEmail + findPhoneCollision")
content = replace_once(content, OLD_CHECK_SITE, NEW_CHECK_SITE, "handler: run the collision check before creating the invite")
with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)
print("Applied 2 edit(s) to", PATH)
