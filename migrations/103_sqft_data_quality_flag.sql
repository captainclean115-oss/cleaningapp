-- PR #148 — sqft data-quality flag.
--
-- clients.sqft already existed as a single column with no provenance
-- tracking. The only writer was maidsEnrichMissingSqft's background
-- MassGIS public-records lookup (PR #78 era) -- there has never been a UI
-- field for a manager to enter sqft by hand, so every existing non-null
-- clients.sqft value today came from that auto-enrichment, not manual
-- entry. This migration adds provenance tracking and a second column to
-- hold the independent public-records value, so a manual entry (added in
-- this same PR's client-edit-modal change) can be compared against
-- auto-enrichment without either ever silently overwriting the other.
--
-- Also fixes, in this same PR (index.html, not this migration): PentaClients
-- ._transformRow never mapped `sqft` onto the in-memory client object,
-- which made maidsEnrichMissingSqft's "already has a value" check
-- (`c.sqft == null`) always true and let it silently re-overwrite a
-- manually-entered sqft on every re-run of the importer. That's fixed
-- alongside this feature since the flag logic depends on sqft/sqft_source
-- being real values in JS, not just in the database.

ALTER TABLE public.clients
  ADD COLUMN sqft_from_records integer,
  ADD COLUMN sqft_source text NOT NULL DEFAULT 'unknown'
    CHECK (sqft_source IN ('manual', 'auto', 'unknown'));

COMMENT ON COLUMN public.clients.sqft IS
  'Manager-facing square footage. Either a manual entry (sqft_source=''manual'', protected from auto-overwrite) or a MassGIS auto-fill (sqft_source=''auto''). May reflect only the portion of the home actually cleaned, which is why it can legitimately be smaller than sqft_from_records.';
COMMENT ON COLUMN public.clients.sqft_from_records IS
  'Independent public-records (MassGIS parcel data) square footage, written only by maidsEnrichMissingSqft. Never used to overwrite a manual sqft entry -- purely a comparison value for flag_sqft_discrepancies() and the client-card mismatch badge.';
COMMENT ON COLUMN public.clients.sqft_source IS
  'Provenance of the `sqft` column: manual (entered via the client edit modal, never auto-overwritten), auto (MassGIS-derived, safe to refresh), unknown (never set by either path).';

-- Backfill: every pre-existing non-null sqft value came from the
-- background enrichment job (confirmed -- no manual entry path existed
-- before this PR), so tag it 'auto', not the 'unknown' default. This
-- matters: leaving these as 'unknown' would be harmless for the flag
-- logic (which only fires on sqft_source='manual'), but tagging them
-- 'auto' correctly keeps them eligible for maidsEnrichMissingSqft's
-- "safe to refresh" path instead of silently freezing a possibly-stale
-- pre-migration estimate forever.
UPDATE public.clients SET sqft_source = 'auto' WHERE sqft IS NOT NULL;

-- Data-quality report: flags clients whose manually-entered sqft differs
-- from public records by more than 10%. Plain SECURITY INVOKER, relies on
-- the existing clients_select RLS policy for tenant scoping (same
-- convention as flag_recurring_projection_issues, migration 102) -- never
-- auto-fixes, matches this codebase's existing "report only, admin
-- decides" pattern for data-quality flags.
--
-- Formula mirrors _sqftMismatchInfo() in index.html EXACTLY (denominator
-- is the manual sqft, not records, not an average) -- keep both in sync if
-- this threshold ever changes. This is the one place in this feature
-- where the same logic necessarily exists twice (JS for the card badge,
-- SQL for the bulk report) since there's no shared runtime between them.
CREATE OR REPLACE FUNCTION public.flag_sqft_discrepancies()
RETURNS TABLE (
  client_id uuid,
  external_id text,
  first_name text,
  last_name text,
  sqft integer,
  sqft_from_records integer,
  diff_pct integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.id, c.external_id, c.first_name, c.last_name, c.sqft, c.sqft_from_records,
         ROUND(ABS(c.sqft - c.sqft_from_records)::numeric / c.sqft * 100)::integer AS diff_pct
  FROM public.clients c
  WHERE c.sqft_source = 'manual'
    AND c.sqft IS NOT NULL
    AND c.sqft > 0
    AND c.sqft_from_records IS NOT NULL
    AND ABS(c.sqft - c.sqft_from_records)::numeric / c.sqft > 0.10
  ORDER BY diff_pct DESC
$$;

GRANT EXECUTE ON FUNCTION public.flag_sqft_discrepancies() TO authenticated;
