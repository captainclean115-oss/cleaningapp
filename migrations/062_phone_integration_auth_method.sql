-- Phase 1 of SMS strategy (Path B): support RingCentral JWT bearer-grant
-- auth alongside the existing OAuth refresh-token flow.
--
-- We keep auth_method inside the credentials JSONB rather than promoting
-- it to a top-level column for two reasons:
--   1. The existing get_active_phone_integration RPC + every read site
--      already pull the JSONB; no signature change ripples needed.
--   2. JWT credentials are a fundamentally different credential SHAPE
--      (long-lived signed assertion, no refresh token), so they belong
--      colocated with the rest of that shape.
--
-- Supported credential JSONB shapes after this migration:
--
--   OAuth (legacy, current state for Manna):
--     {
--       "auth_method":   "oauth",          -- optional; missing = oauth
--       "client_id":     "<RC client_id>",
--       "client_secret": "<RC client_secret>",
--       "refresh_token": "<long-lived OAuth refresh token>"
--     }
--
--   JWT (Path B — recommended for new tenants):
--     {
--       "auth_method":     "jwt",
--       "client_id":       "<RC client_id>",
--       "client_secret":   "<RC client_secret>",
--       "jwt_credential":  "<long-lived signed JWT assertion>"
--     }
--
--   Env-source (transitional, may be dropped in PR2):
--     { "source": "env" }
--
-- The Edge Functions (send-sms, rc-inbox, rc-mark-read) read auth_method
-- from the JSONB and branch on it:
--   oauth  → grant_type=refresh_token
--   jwt    → grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
-- Missing / unknown auth_method defaults to 'oauth' (preserves behavior
-- for every row that existed before this migration).
--
-- We avoid a hard CHECK constraint on credentials.auth_method because:
--   - Postgres JSONB CHECK constraints on nested keys are brittle and
--     hard to evolve. App-level validation is in the Edge Functions and
--     in the Admin UI.
--   - 'source: env' rows have no auth_method key at all and must remain
--     valid.

-- Backfill existing rows for explicitness. Optional — the Edge Functions
-- already treat a missing auth_method as 'oauth' — but writing it down
-- in the row makes the row self-describing and matches what the new
-- Admin UI saves for fresh OAuth setups.
UPDATE public.business_phone_integrations
SET    credentials = credentials || jsonb_build_object('auth_method', 'oauth')
WHERE  deleted_at IS NULL
  AND  credentials IS NOT NULL
  AND  credentials ? 'refresh_token'        -- only OAuth-shaped rows
  AND  NOT (credentials ? 'auth_method')    -- and only if not already set
  AND  NOT (credentials ? 'source');        -- skip env-source rows

-- No DDL changes. The shape of business_phone_integrations is unchanged;
-- only the documented JSONB contract is extended. PR2 will add
-- 'native_sms' to the provider CHECK constraint when the Native SMS
-- fallback ships.
