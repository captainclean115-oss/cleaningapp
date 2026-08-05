-- 090 — Backfill stale 'scheduled' jobs to 'completed' (PR #85).
--
-- PR #83 fixed the revenue clock to correctly count only status=
-- 'completed' jobs -- but 22 real jobs for Manna are still stuck at
-- 'scheduled' despite their date already being in the past (earliest
-- 2025-01-10, latest 2026-08-03, the same Jane Mahle job flagged in
-- the PR #83 diagnosis). These reflect the Maids export's status AT
-- EXPORT TIME, before the clean actually happened -- real time has
-- since passed for every one of them. One-time data fix, not a
-- schema change: no ongoing rule is added that auto-completes jobs as
-- their date passes (that's a deliberately different, more careful
-- design -- see PR #86's realized-vs-projected revenue split).
--
-- Scoped to Manna (business_id) and to genuinely past dates
-- (date < CURRENT_DATE) -- never touches today/future 'scheduled'
-- jobs, and never touches 'cancelled' jobs.

UPDATE public.jobs
SET status = 'completed', updated_at = now()
WHERE business_id = '48532f06-0625-415b-9091-2638bed6506d'
  AND status = 'scheduled'
  AND date < CURRENT_DATE;
