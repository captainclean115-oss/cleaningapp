-- Linter caught this (function_search_path_mutable) right after PR #1
-- merged: haversine_meters was missing SET search_path, unlike every
-- other function in this project. Pure-math function, no table access,
-- so the practical risk was low -- but it's called from SECURITY
-- DEFINER functions (resolve_job_from_gps_stop), and a mutable
-- search_path anywhere in that call chain is exactly the bug class the
-- linter exists to catch. One-line fix, no behavior change.
CREATE OR REPLACE FUNCTION public.haversine_meters(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT 2 * 6371000 * asin(
    sqrt(
      sin(radians(lat2 - lat1) / 2) ^ 2 +
      cos(radians(lat1)) * cos(radians(lat2)) *
      sin(radians(lng2 - lng1) / 2) ^ 2
    )
  );
$$;
