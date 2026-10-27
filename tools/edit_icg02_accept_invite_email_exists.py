#!/usr/bin/env python3
"""Invite-collision guard, step 2: accept-invite's createUser failure
handling. When the underlying GoTrue error is specifically
email_exists (code, or 422 status, or the "already been registered"
message), return a friendly, specific 409 instead of the generic
headline, and console.error the real reason (error code + employee id
only -- never a phone number or token). Every OTHER createUser failure
keeps the existing generic message but now also console.errors first --
today it's returned to the caller as `detail` but never logged
server-side at all.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import replace_once

PATH = "supabase/functions/accept-invite/index.ts"

OLD = """    if (createErr || !created.user) {
      return json(500, { error: "Failed to create auth user", detail: createErr?.message });
    }"""

NEW = """    if (createErr || !created.user) {
      const errCode = (createErr as { code?: string; status?: number } | undefined)?.code;
      const errStatus = (createErr as { code?: string; status?: number } | undefined)?.status;
      const isEmailExists = errCode === "email_exists" || errStatus === 422 || /already been registered/i.test(createErr?.message || "");
      if (isEmailExists) {
        console.error("[accept-invite] createUser failed (email_exists) for employee", employee.id, "-- code:", errCode || errStatus);
        return json(409, { error: "This phone number is already registered to another account. Ask the office to check the phone number on your profile." });
      }
      console.error("[accept-invite] createUser failed for employee", employee.id, "-- error:", createErr?.message);
      return json(500, { error: "Failed to create auth user", detail: createErr?.message });
    }"""

with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()
content = replace_once(content, OLD, NEW, "accept-invite: email_exists -> 409 friendly message + console.error")
with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)
print("Applied 1 edit(s) to", PATH)
