-- Migration 018: Add lat/lng coords to clients table
-- Sprint 7-map: eliminates per-render Nominatim geocoding rate-limit issue.
-- Geocoding becomes save-time, one-shot per new client.
-- Map plot reads coords directly from PentaClients cache.
-- Apply via Supabase SQL editor or MCP apply_migration.

-- 1) Add coordinate columns
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS geocode_status TEXT DEFAULT 'pending';
  -- 'pending' | 'ok' | 'failed' | 'manual'

-- 2) Index for "has coords" filters and status reporting
CREATE INDEX IF NOT EXISTS idx_clients_geocode_status ON public.clients(geocode_status);

-- 3) Verification queries (run after migration)
-- SELECT geocode_status, COUNT(*) FROM public.clients
--   WHERE business_id = '48532f06-0625-415b-9091-2638bed6506d'
--     AND deleted_at IS NULL
--   GROUP BY geocode_status;
