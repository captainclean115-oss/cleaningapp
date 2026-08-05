-- PR #96 — one-time backfill for the frequency mislabel bug fixed in
-- index.html's maidsBuildPreview (see the code comment there for the
-- full mechanism). 13 Manna clients were tagged 'recurring' (correct)
-- but had frequency='OMS' (wrong -- driven by a chronologically-later
-- OMS-categorized row from the 2025_combined file outracing their
-- real 2026_recurring-file frequency).
--
-- Backfilling only the 6 with a clear, high-confidence signal from
-- their own real job-visit cadence (>=5 completed/scheduled jobs,
-- consistent median gap between visits, mapped to the nearest
-- standard frequency_code bucket: <10d=WEK, 10-17d=EOW, 17-25d=ETW,
-- 25-33d=MON, >33d=EFW). The remaining 7 (Shannon DelGallo, Mari
-- Donahue, Rebecca Duong, Jennifer Garner-DNC, Jennifer Heaton,
-- Odelle Kinder-Wells, Ellen Ziedenburg) have 0-2 jobs on file --
-- not enough signal to infer a cadence reliably without the source
-- CSVs, which aren't stored server-side (client-side-only import, see
-- PR #94's capture-completeness sweep). Left as frequency='OMS' and
-- reported to Tom by name for manual correction rather than guessed.

UPDATE public.clients SET frequency = 'RMS-MON', updated_at = now()
WHERE business_id = '48532f06-0625-415b-9091-2638bed6506d'
  AND external_id IN ('10146712', '1880294', '10624069', '1841793'); -- Dilworth, Hoffman, Kane, Myer (median gap ~28-30d)

UPDATE public.clients SET frequency = 'RMS-EOW', updated_at = now()
WHERE business_id = '48532f06-0625-415b-9091-2638bed6506d'
  AND external_id = '10903727'; -- Doucette (median gap 14d)

UPDATE public.clients SET frequency = 'RMS-ETW', updated_at = now()
WHERE business_id = '48532f06-0625-415b-9091-2638bed6506d'
  AND external_id = '1879963'; -- Gallagher (median gap 21d)
