-- Feature: Claire voice on/off toggle. Tom doesn't want to hear Claire
-- speak most of the time -- reading is faster -- so a toggle in her view
-- turns off text-to-speech (text replies always still render). The
-- setting is persisted per-user in the EXISTING public.users.settings
-- jsonb column (via window.PentaSettings, already used for claire_photo,
-- rc_token, etc. -- no new column needed) so it's already per-user and
-- already backed up in the DB. No schema change to users itself here.
--
-- What IS new: PentaSettings previously only synced on explicit load()
-- (boot) or set() (same tab) -- there was no live push when a DIFFERENT
-- device changed the same row, so flipping the toggle on the phone
-- wouldn't reach an already-open desktop tab until it reloaded. Fixed by
-- subscribing each browser to postgres_changes on ITS OWN users row
-- (filter: id=eq.<own auth uid>), same pattern already used throughout
-- this app (PentaJobs, PentaAssignments, PentaForms, PentaChatMessages,
-- etc.) -- but `users` was never added to the supabase_realtime
-- publication, so no postgres_changes event has ever fired for it. This
-- is that one-time enablement, idempotent via the DO block guard (ALTER
-- PUBLICATION ... ADD TABLE has no IF NOT EXISTS on this PG version),
-- copied verbatim from migration 057's identical need for chat_messages.
--
-- Scope/safety: this turns on realtime for ALL rows/columns of `users`,
-- not just `settings` -- but each client only ever subscribes with a
-- filter scoped to its own signed-in row (id=eq.<own uid>), so no browser
-- receives another user's row over this channel regardless of the
-- broader publication membership; RLS (public.users_select) still governs
-- what a subscription is allowed to receive at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.users';
  END IF;
END $$;

-- Verify after apply:
-- select schemaname, tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' and tablename = 'users';
