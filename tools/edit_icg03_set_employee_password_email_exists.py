#!/usr/bin/env python3
"""Invite-collision guard, step 3: set-employee-password's createUser
failure handling -- same email_exists special-case + console.error-
before-returning discipline as accept-invite's own fix. Also corrects
this file's own stale "Deploy with" comment: the function is actually
LIVE with --no-verify-jwt (confirmed via mcp__supabase__list_edge_functions,
verify_jwt: false), not the default verify_jwt=true the comment implies.
Not re-deploying here -- just fixing the comment so the next person who
runs it verbatim doesn't accidentally flip the live setting.
"""
import sys
sys.path.insert(0, "tools")
from _apply_edits import replace_once

PATH = "supabase/functions/set-employee-password/index.ts"

OLD_COMMENT = """// Deploy with: supabase functions deploy set-employee-password --project-ref wymoezilyjmyibmuqqmr"""
NEW_COMMENT = """// Deploy with: supabase functions deploy set-employee-password --project-ref wymoezilyjmyibmuqqmr --no-verify-jwt
// (confirmed live setting via mcp__supabase__list_edge_functions: verify_jwt=false --
// this comment previously omitted the flag, which would have flipped it back to
// true on a future redeploy. The function verifies the caller's JWT itself via
// callerClient.auth.getUser() below, so --no-verify-jwt is intentional, not a gap.)"""

OLD_CREATEUSER = """    if (createErr || !created.user) {
      return json(500, { error: "Failed to create auth user", detail: createErr?.message });
    }
    authUserId = created.user.id;"""

NEW_CREATEUSER = """    if (createErr || !created.user) {
      const errCode = (createErr as { code?: string; status?: number } | undefined)?.code;
      const errStatus = (createErr as { code?: string; status?: number } | undefined)?.status;
      const isEmailExists = errCode === "email_exists" || errStatus === 422 || /already been registered/i.test(createErr?.message || "");
      if (isEmailExists) {
        console.error("[set-employee-password] createUser failed (email_exists) for employee", emp.id, "-- code:", errCode || errStatus);
        return json(409, { error: "This phone number is already registered to another account. Ask the office to check the phone number on your profile." });
      }
      console.error("[set-employee-password] createUser failed for employee", emp.id, "-- error:", createErr?.message);
      return json(500, { error: "Failed to create auth user", detail: createErr?.message });
    }
    authUserId = created.user.id;"""

with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()
content = replace_once(content, OLD_COMMENT, NEW_COMMENT, "fix stale deploy comment (verify_jwt)")
content = replace_once(content, OLD_CREATEUSER, NEW_CREATEUSER, "set-employee-password: email_exists -> 409 friendly message + console.error")
with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)
print("Applied 2 edit(s) to", PATH)
