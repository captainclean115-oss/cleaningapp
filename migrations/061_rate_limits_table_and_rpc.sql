-- v11.0.x — Edge Function rate limiting infrastructure.
--
-- Adds a rate_limits table and SECURITY DEFINER RPCs that Edge
-- Functions call to enforce per-user (or per-IP) call limits.
--
-- Design notes:
--   Each (key, window_start) tuple is one row. The RPC bumps the
--   counter for the current window and rejects if it exceeds max_calls.
--   "key" is opaque to the table — Edge Functions construct it as
--   "<function_name>:<user_or_ip_identifier>".
--
--   Two RPC variants:
--     check_rate_limit            — single window (hourly OR daily)
--     check_rate_limit_dual       — both windows in one atomic call,
--                                   for send-sms which needs 200/hr
--                                   AND 1000/day caps simultaneously.
--
--   Concurrency: the UPSERT + atomic increment via ON CONFLICT
--   guarantees correctness if two requests arrive in the same
--   millisecond. No row-level locking needed.
--
--   Limits in use (set in Edge Functions, not here):
--     send-sms        200/hour/user AND 1000/day/user (dual)
--     translate-chat  300/hour/user
--     accept-invite   10/hour/IP
--
--   Each tenant brings their own SMS provider credentials, so SMS
--   abuse cost is borne by that tenant — limits are sized to be
--   well above legitimate manager use so real operations are never
--   blocked, while still catching runaway loops within seconds.

CREATE TABLE IF NOT EXISTS public.rate_limits (
  key           text        NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer     NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, window_start)
);

-- Plain index on window_start. An earlier draft used a partial index
-- with a predicate of `WHERE window_start < (now() - interval '1 day')`,
-- but Postgres rejected it because now() is STABLE, not IMMUTABLE.
-- The cleanup query (`DELETE WHERE window_start < now() - interval '1 day'`)
-- still uses this index for the range scan.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON public.rate_limits (window_start);

-- ─── Single-window check ────────────────────────────────────────
-- Returns true if the call is allowed, false if rate-limited.
-- Edge Functions check the return value and respond 429 on false.
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key            text,
  p_max_calls      integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start timestamptz;
  v_count        integer;
BEGIN
  v_window_start := date_trunc('second', now())
    - make_interval(secs => extract(epoch from now())::bigint % p_window_seconds);

  INSERT INTO public.rate_limits (key, window_start, count, updated_at)
  VALUES (p_key, v_window_start, 1, now())
  ON CONFLICT (key, window_start)
  DO UPDATE SET
    count      = public.rate_limits.count + 1,
    updated_at = now()
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_calls;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;

-- ─── Dual-window check (for send-sms) ───────────────────────────
-- Atomically checks BOTH an hourly and a daily limit. Returns true
-- only if both are within bounds. Bumps both counters regardless
-- (so a daily-limit denial still counts against the hourly window —
-- but in practice if you're over daily you're nowhere near hourly).
CREATE OR REPLACE FUNCTION public.check_rate_limit_dual(
  p_key            text,
  p_hourly_max     integer,
  p_daily_max      integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hour_start  timestamptz;
  v_day_start   timestamptz;
  v_hour_count  integer;
  v_day_count   integer;
BEGIN
  v_hour_start := date_trunc('hour', now());
  v_day_start  := date_trunc('day',  now());

  INSERT INTO public.rate_limits (key, window_start, count, updated_at)
  VALUES (p_key || ':hour', v_hour_start, 1, now())
  ON CONFLICT (key, window_start)
  DO UPDATE SET count = public.rate_limits.count + 1, updated_at = now()
  RETURNING count INTO v_hour_count;

  INSERT INTO public.rate_limits (key, window_start, count, updated_at)
  VALUES (p_key || ':day', v_day_start, 1, now())
  ON CONFLICT (key, window_start)
  DO UPDATE SET count = public.rate_limits.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  RETURN (v_hour_count <= p_hourly_max) AND (v_day_count <= p_daily_max);
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit_dual(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit_dual(text, integer, integer) TO service_role;

-- ─── Cleanup ────────────────────────────────────────────────────
-- Deletes rate_limits rows older than 24h. Edge Functions never
-- need this; it runs from pg_cron.
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.rate_limits
  WHERE window_start < (now() - interval '1 day');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits() TO service_role;

-- To schedule daily cleanup, enable the pg_cron extension in the
-- Supabase Dashboard (Database → Extensions → pg_cron → Enable),
-- then run this once in SQL Editor:
--
--   SELECT cron.schedule(
--     'cleanup_rate_limits_daily',
--     '0 3 * * *',
--     $$SELECT public.cleanup_rate_limits()$$
--   );
--
-- Skipping this is fine for low-volume installs; the table just
-- grows a few rows per active user per day until cleaned up manually.

-- ─── RLS ────────────────────────────────────────────────────────
-- Service-role-only. Authenticated users cannot read rate-limit
-- data (it would leak abuse patterns and IPs).
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies = no access for anon/authenticated. Only service_role
-- bypasses RLS, which is exactly what we want.
