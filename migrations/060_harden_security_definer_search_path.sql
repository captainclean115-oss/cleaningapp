-- v11.0.x — Defense-in-depth: pin search_path on the three SECURITY
-- DEFINER auth functions that gate RLS across the entire schema.
--
-- Without an explicit search_path, a SECURITY DEFINER function inherits
-- the caller's search_path at invocation time. If an attacker could
-- create a schema earlier in the search_path with a table named `users`,
-- they could trick the function into reading their malicious table
-- instead of public.users — bypassing tenant scoping for every RLS
-- policy that uses these functions.
--
-- In current Supabase, schema creation is restricted to privileged
-- roles, so this is not a live vulnerability. But pinning search_path
-- is the Postgres security best practice and protects against future
-- role/extension changes that might relax those restrictions.
--
-- pg_temp is included by Postgres convention to prevent temp-table
-- shadowing of referenced objects.
--
-- No behavior change for any caller. All three functions continue to
-- read from public.users exactly as before.

ALTER FUNCTION public.auth_belongs_to_business(uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.auth_user_business_ids()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.auth_has_franchisor_access(uuid)
  SET search_path = public, pg_temp;
