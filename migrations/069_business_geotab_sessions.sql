-- PR #38 was the wrong fix. The 401 cascade Tom kept hitting after
-- `gpsInit()` boot fan-out (8+ concurrent _geotabCall) was NOT a stale
-- Supabase JWT — supabase-js v2.39's `functions.invoke` swallows
-- non-2xx response bodies into `error.context.response`, so the
-- browser saw `data: null` and PR #38 assumed "Invalid JWT". Log scan
-- showed the actual failure: the EF's `getCachedSession` was throwing
-- because Geotab's "10 Authenticate calls per minute per user" hard
-- limit kept tripping. Edge Function isolates auto-scale, and the
-- existing session cache was MODULE-LEVEL (in-memory per isolate).
-- Every cold isolate re-authenticated; 8+ fan-out across N isolates
-- blew the 10/min budget within a second, and every subsequent
-- isolate that tried to auth for the same minute got "API calls
-- quota exceeded" → EF returned 401 "Geotab authentication failed"
-- → cascade visible in execution_time_ms=200-600 (function-level,
-- NOT gateway-level ~0ms). The single-flight in PR #37 dedupes
-- WITHIN an isolate but not ACROSS them.
--
-- Fix: persist Geotab sessions in a DB table keyed by business_id.
-- All isolates read from DB first, write on successful auth. One
-- Authenticate call per business per ~50min across the entire fleet.
-- The Geotab 10/min limit becomes effectively unreachable under
-- normal operation (still hit on initial cold-start race, but
-- bounded to N isolates spinning up simultaneously — typically 1-2,
-- always under the limit).
--
-- Session credentials are tenant-wide (one Geotab account per
-- business), so business_id is the natural PK. Service-role only —
-- no RLS policies needed; users have zero direct access. The session
-- token grants Geotab API access for the business, so its threat
-- model is the same as the credentials in business_geotab_integrations.

CREATE TABLE IF NOT EXISTS public.business_geotab_sessions (
  business_id  uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  session_id   text        NOT NULL,
  user_name    text        NOT NULL,
  database     text        NOT NULL,
  server       text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.business_geotab_sessions ENABLE ROW LEVEL SECURITY;
-- No policies — service_role bypasses RLS, no one else gets a row.

-- ─── RPCs ──────────────────────────────────────────────────────────

-- Returns the active session if it's still valid (with a 30s safety
-- margin so we don't hand out a token that's about to expire mid-call).
-- Service-role only — the EF calls this on every invocation.
CREATE OR REPLACE FUNCTION public.get_geotab_session(
  p_business_id uuid
)
RETURNS TABLE(
  session_id  text,
  user_name   text,
  database    text,
  server      text,
  expires_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT s.session_id, s.user_name, s.database, s.server, s.expires_at
    FROM   public.business_geotab_sessions s
    WHERE  s.business_id = p_business_id
      AND  s.expires_at  > now() + interval '30 seconds'
    LIMIT  1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_geotab_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_geotab_session(uuid) TO service_role;

-- Upsert a session after a successful Geotab Authenticate. ON CONFLICT
-- means a second isolate that lost the race overwrites the loser's
-- session safely — both came from the same credentials so they're
-- functionally equivalent. updated_at moves forward so observability
-- queries can spot drift.
CREATE OR REPLACE FUNCTION public.set_geotab_session(
  p_business_id uuid,
  p_session_id  text,
  p_user_name   text,
  p_database    text,
  p_server      text,
  p_expires_at  timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.business_geotab_sessions
      (business_id, session_id, user_name, database, server, expires_at)
  VALUES
      (p_business_id, p_session_id, p_user_name, p_database, p_server, p_expires_at)
  ON CONFLICT (business_id) DO UPDATE
    SET session_id = EXCLUDED.session_id,
        user_name  = EXCLUDED.user_name,
        database   = EXCLUDED.database,
        server     = EXCLUDED.server,
        expires_at = EXCLUDED.expires_at,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.set_geotab_session(uuid, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_geotab_session(uuid, text, text, text, text, timestamptz) TO service_role;

-- Bust the session when Geotab returns InvalidUserException / session-
-- expired. EF deletes from DB + its own module cache, then re-auths
-- on the next call.
CREATE OR REPLACE FUNCTION public.delete_geotab_session(
  p_business_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.business_geotab_sessions
  WHERE  business_id = p_business_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_geotab_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_geotab_session(uuid) TO service_role;
