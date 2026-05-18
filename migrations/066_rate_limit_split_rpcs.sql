-- Security audit 3b/3c: split-pattern rate-limit RPCs.
--
-- Migration 061 shipped atomic check-and-increment (check_rate_limit,
-- check_rate_limit_dual). That penalizes failures — if the EF aborts
-- AFTER incrementing (e.g., RC token expired, Anthropic 5xx), the
-- caller has consumed budget for a non-call.
--
-- These two RPCs let the caller separate the read from the write:
--   rate_limit_check     — read-only, returns true if under limit
--   rate_limit_increment — bump the counter for the current window
--
-- Caller flow:
--   if (!rate_limit_check(key, max, 3600)) return 429
--   do work
--   if (success) rate_limit_increment(key, 3600)
--
-- Race trade-off: N concurrent requests at count=max-1 can all pass the
-- check before any of them increments, overshooting to max-1+N. At
-- production limits (100/hr send-sms, 60/hr inbox, 300/hr mark-read,
-- 60/hr weather) a single user isn't firing N=10+ parallel calls, so
-- the overshoot is acceptable and well below abuse thresholds.
--
-- The atomic check_rate_limit + check_rate_limit_dual RPCs are LEFT IN
-- PLACE — claire-chat still uses the atomic single, and any future
-- caller that wants strict no-overshoot semantics can keep using them.

CREATE OR REPLACE FUNCTION public.rate_limit_check(
  p_key            text,
  p_max            integer,
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

  SELECT count INTO v_count
  FROM   public.rate_limits
  WHERE  key = p_key AND window_start = v_window_start;

  RETURN COALESCE(v_count, 0) < p_max;
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_check(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rate_limit_check(text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.rate_limit_increment(
  p_key            text,
  p_window_seconds integer DEFAULT 3600
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start timestamptz;
BEGIN
  v_window_start := date_trunc('second', now())
    - make_interval(secs => extract(epoch from now())::bigint % p_window_seconds);

  INSERT INTO public.rate_limits (key, window_start, count, updated_at)
  VALUES (p_key, v_window_start, 1, now())
  ON CONFLICT (key, window_start)
  DO UPDATE SET
    count      = public.rate_limits.count + 1,
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_increment(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rate_limit_increment(text, integer) TO service_role;
