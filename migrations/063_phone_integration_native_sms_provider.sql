-- Phase 1 of SMS strategy (PR2 of split): add 'native_sms' as a valid
-- provider. Used by tenants who don't want an SMS-API integration —
-- every dispatch site opens a sms: URI to hand off to the user's native
-- SMS app instead of calling send-sms. Inbox is unavailable in this
-- mode (replies go to the user's phone, not into Penta).
--
-- credentials JSONB is irrelevant for native_sms rows; the EF send path
-- is never invoked. We don't enforce credentials='{}' so older rows
-- that flip from 'ringcentral' to 'native_sms' don't choke on leftover
-- keys.

ALTER TABLE public.business_phone_integrations
  DROP CONSTRAINT IF EXISTS business_phone_integrations_provider_chk;

ALTER TABLE public.business_phone_integrations
  ADD CONSTRAINT business_phone_integrations_provider_chk
  CHECK (provider IN ('ringcentral', 'text_request', 'twilio', 'native_sms'));
