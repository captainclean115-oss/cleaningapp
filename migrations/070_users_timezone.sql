-- Per-user timezone. Auto-detected from the browser on first login
-- (Intl.DateTimeFormat().resolvedOptions().timeZone) and persisted here.
-- All client-side renderers that show timestamps to a user should pull
-- this and pass it as toLocaleTimeString({ timeZone }) so e.g. a manager
-- based in California sees PDT while one based in Massachusetts sees EDT.
--
-- Discovered when Tom (CA-based owner) viewed Manna fleet (MA-based work)
-- and saw "6:33 AM client arrival" — actually 9:33 AM EDT but rendered
-- in his browser's PDT. The fleet's TZ doesn't matter as much as the
-- viewer's: an MA admin and a CA owner should each see their own local
-- time, with the underlying timestamps still stored in UTC.
--
-- Nullable: a NULL row triggers the auto-detect + write path on next
-- login. No backfill — existing users get populated on their next
-- session. Free-form text (IANA name) so we don't have to maintain
-- an enum; the values come from the browser's Intl tables anyway.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS timezone text;
