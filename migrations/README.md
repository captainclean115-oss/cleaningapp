# Migrations

Schema migrations for the Supabase database backing the Penta cleaning app.

## How migrations are applied

Until Sprint 6.9 we did not version migrations locally — they were authored ad hoc in the Supabase SQL editor. Starting with Migration 016 (Sprint 6.9) we keep the SQL here for review/auditability. Application is still manual: paste the file contents into the Supabase SQL editor and run.

## History (pre-016, not stored here)

| #   | Sprint | Summary                                                               |
| --- | ------ | --------------------------------------------------------------------- |
| 011 | 6.x    | Initial `public.employees` table + RLS                                |
| 012 | 6.3a   | Added: `ssn_last4`, `address`, `city`, `state`, `zip`, emergency contact name/phone, `pay_type`, `pay_rate`, `manager_notes` |
| 013 | 6.3a   | (gap — minor RLS adjustments)                                         |
| 014 | 6.3a   | Added 10 form-field columns: `shirt_size`, `pants_size`, `work_auth`, `has_license`, `experience`, `experience_notes`, `available_days`, `languages_spoken`, `preferred_start_time`, `emergency_contact_relationship` |
| 015 | 6.7    | `ALTER PUBLICATION supabase_realtime ADD TABLE public.employees` (applied; realtime client code rolled back in 6.7-rollback, no-op left in DB) |

## Going forward

Each new migration:

1. Numbered `NNN_short_name.sql` in this directory
2. Self-contained (uses `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` where applicable)
3. Includes verification queries at the bottom (commented out) for manual run after apply
4. Applied via Supabase SQL editor — record the apply date in the file header
