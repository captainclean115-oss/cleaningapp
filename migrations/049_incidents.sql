-- v11.0.12 — Incident Report system (Phase B).
--
-- Liability-track flow. Replaces the localStorage cleanco_pending
-- write that submitJobIncident used. Manager-only resolution flow.
-- No client SMS. Photos go to Supabase Storage bucket
-- 'incident-photos' (Tom creates the bucket manually in Dashboard
-- before testing — see PR description).
--
-- Status workflow: open → in_review → resolved | closed.
-- audit_log captures status transitions via the trigger extension in
-- mig 050.
--
-- photo_expires_at is the anchor for a future retention cleanup job —
-- not enforced yet, just exposed.
--
-- Drops an earlier legacy public.incidents table (different schema:
-- reported_by_user_id / involved_user_ids[] / severity / category /
-- resolution / resolved_at — no status workflow, no photo, zero rows)
-- that pre-dated this work. CASCADE because the legacy table had no
-- dependents but we want to be safe against any stray indexes/FKs.

DROP TABLE IF EXISTS public.incidents CASCADE;

CREATE TABLE public.incidents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  job_id              uuid,
  client_id           uuid,
  reported_by         uuid REFERENCES public.users(id),
  incident_type       text NOT NULL CHECK (incident_type IN (
                        'property_damage','injury','vehicle_accident',
                        'client_complaint','pet_issue','safety_hazard','other'
                      )),
  description         text,
  photo_url           text,
  photo_path          text,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN (
                        'open','in_review','resolved','closed'
                      )),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  status_changed_by   uuid REFERENCES public.users(id),
  resolution_note     text,
  reported_at         timestamptz NOT NULL DEFAULT now(),
  photo_expires_at    timestamptz DEFAULT (now() + interval '1 year'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_incidents_business_open
  ON public.incidents (business_id, status)
  WHERE status IN ('open','in_review');

CREATE INDEX idx_incidents_client
  ON public.incidents (business_id, client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX idx_incidents_job
  ON public.incidents (business_id, job_id)
  WHERE job_id IS NOT NULL;

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

CREATE POLICY incidents_select ON public.incidents FOR SELECT
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY incidents_insert ON public.incidents FOR INSERT
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

CREATE POLICY incidents_update ON public.incidents FOR UPDATE
USING (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
)
WITH CHECK (
  business_id = (SELECT business_id FROM public.users WHERE auth_user_id = auth.uid())
);

GRANT SELECT, INSERT, UPDATE ON public.incidents TO authenticated;

-- ─── BEFORE UPDATE trigger: bump updated_at, auto-stamp status_changed_* ─
-- Avoids forcing every changeStatus caller to pass three correlated
-- fields. When status doesn't change, just bumps updated_at.
CREATE OR REPLACE FUNCTION public.incidents_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_changed_at = now();
    -- Only auto-set status_changed_by if the caller didn't already
    -- supply it (lets the app pass a specific value if it wants).
    IF NEW.status_changed_by IS NULL OR NEW.status_changed_by = OLD.status_changed_by THEN
      SELECT u.id INTO NEW.status_changed_by
      FROM public.users u
      WHERE u.auth_user_id = auth.uid()
      LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS incidents_updated_at_trigger ON public.incidents;
CREATE TRIGGER incidents_updated_at_trigger
  BEFORE UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.incidents_set_updated_at();
