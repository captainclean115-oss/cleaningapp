#!/usr/bin/env python3
"""Phone + password login feature (fix). The users upsert and the final
response must reflect newAccountEmail (what the auth account ACTUALLY
got), not the original employee.email -- otherwise, for a brand-new
phone-based account, public.users.email would silently disagree with
auth.users' real email, and accept-invite.html's "Your sign-in email"
display would show the WRONG address. The pre-existing manager-hire-row
lookup (.ilike("email", employee.email)) correctly keeps using the
ORIGINAL email -- that row was created at hire time under the old
email, independent of this change -- so it is deliberately left alone.
"""
PATH = "supabase/functions/accept-invite/index.ts"

with open(PATH, "r", encoding="utf-8") as f:
    content = f.read()

edits = [
    (
        """        business_id: employee.business_id,
        role: preserveRole,
        email: employee.email,
        first_name: employee.first_name,""",
        """        business_id: employee.business_id,
        role: preserveRole,
        email: newAccountEmail,
        first_name: employee.first_name,""",
    ),
    (
        """  return json(200, { success: true, email: employee.email });""",
        """  return json(200, { success: true, email: newAccountEmail });""",
    ),
]

for old, new in edits:
    count = content.count(old)
    if count != 1:
        raise SystemExit(f"FAIL: expected exactly 1 occurrence of a snippet, found {count}:\n{old}")
    content = content.replace(old, new, 1)

with open(PATH, "w", encoding="utf-8") as f:
    f.write(content)
print("Applied 2 edit(s) to", PATH)
