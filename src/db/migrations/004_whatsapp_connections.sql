-- =====================================================================
--  Migration 0003 — WhatsApp connections
--
--  Moves WhatsApp wiring from env-vars-only into the database so the
--  dashboard can show and manage it:
--    * whatsapp_accounts        — Meta Cloud API senders (WABA + phone
--                                 number id). Secrets go in Supabase
--                                 Vault; this table stores REFERENCES to
--                                 them, never raw tokens.
--    * whatsapp_contacts        — per-person connection state: opt-in,
--                                 verification, 24-hour session window.
--    * whatsapp_webhook_events  — raw inbound event log (idempotency +
--                                 audit; Meta retries until it sees 200).
--    * whatsapp_delivery_status — sent/delivered/read/failed per message.
--    * v_wa_session_open        — who can receive free-form text right
--                                 now vs. needing an approved template.
--
--  RLS: admin (owner/manager) read via 0002 helpers; staff see their own
--  contact row; service_role remains the only writer. Anon: nothing.
--  Idempotent; safe to re-run.
-- =====================================================================

-- ======================== SENDER ACCOUNTS ============================

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id                    bigserial PRIMARY KEY,
  label                 text NOT NULL DEFAULT 'Primary',
  waba_id               text NOT NULL,             -- WhatsApp Business Account id
  phone_number_id       text NOT NULL UNIQUE,      -- Meta phone number id (sender)
  display_phone         text,                      -- human-readable number
  api_version           text NOT NULL DEFAULT 'v21.0',
  -- Names of Supabase Vault secrets. NEVER store raw tokens here.
  --   vault: select vault.create_secret('<token>', 'wa_token_primary');
  token_secret_name     text,                      -- system-user access token
  app_secret_name       text,                      -- for X-Hub-Signature-256
  verify_token_name     text,                      -- webhook verify token
  template_reminder     text NOT NULL DEFAULT 'qcms_task_reminder',
  template_escalation   text NOT NULL DEFAULT 'qcms_escalation',
  template_lang         text NOT NULL DEFAULT 'en_US',
  status                text NOT NULL DEFAULT 'unconfigured'
                          CHECK (status IN ('unconfigured','dry_run','pending_webhook','live','disabled')),
  webhook_verified_at   timestamptz,
  last_send_at          timestamptz,
  last_error            text,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_wa_accounts_touch ON whatsapp_accounts;
CREATE TRIGGER trg_wa_accounts_touch
  BEFORE UPDATE ON whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ======================= PER-PERSON CONTACTS =========================

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id               bigserial PRIMARY KEY,
  person_id        bigint NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
  account_id       bigint REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  wa_id            text NOT NULL UNIQUE,   -- E.164 digits, no '+', as Meta sends
  profile_name     text,                   -- name Meta reports for the contact
  opt_in_status    text NOT NULL DEFAULT 'pending'
                     CHECK (opt_in_status IN ('pending','opted_in','opted_out','invalid')),
  opted_in_at      timestamptz,
  opted_out_at     timestamptz,
  verified_at      timestamptz,            -- first successful round trip
  last_outbound_at timestamptz,
  last_inbound_at  timestamptz,            -- drives the 24h session window
  failure_count    integer NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_contacts_inbound ON whatsapp_contacts(last_inbound_at);

DROP TRIGGER IF EXISTS trg_wa_contacts_touch ON whatsapp_contacts;
CREATE TRIGGER trg_wa_contacts_touch
  BEFORE UPDATE ON whatsapp_contacts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Backfill contact rows from people.whatsapp_number (idempotent).
INSERT INTO whatsapp_contacts (person_id, wa_id, opt_in_status)
SELECT p.id, p.whatsapp_number, 'pending'
FROM people p
WHERE p.whatsapp_number IS NOT NULL
  AND p.active = 1
ON CONFLICT (person_id) DO NOTHING;

-- ======================= WEBHOOK EVENT LOG ===========================

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id             bigserial PRIMARY KEY,
  account_id     bigint REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  event_type     text,                     -- message | status | error | other
  wa_message_id  text,                     -- Meta message id when present
  wa_id          text,                     -- sender/recipient number
  payload        jsonb NOT NULL,           -- raw entry, verbatim
  signature_ok   boolean,                  -- X-Hub-Signature-256 check result
  processed_at   timestamptz,
  process_error  text,
  received_at    timestamptz NOT NULL DEFAULT now()
);

-- Redelivered events become no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_events_dedupe
  ON whatsapp_webhook_events(wa_message_id, event_type)
  WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_events_when ON whatsapp_webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_wa_events_open
  ON whatsapp_webhook_events(received_at) WHERE processed_at IS NULL;

-- ======================= DELIVERY STATUSES ===========================

CREATE TABLE IF NOT EXISTS whatsapp_delivery_status (
  id             bigserial PRIMARY KEY,
  message_id     bigint REFERENCES messages(id) ON DELETE CASCADE,
  wa_message_id  text NOT NULL,
  status         text NOT NULL CHECK (status IN ('accepted','sent','delivered','read','failed')),
  error_code     text,
  error_detail   text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wa_message_id, status)
);

CREATE INDEX IF NOT EXISTS idx_wa_status_msg ON whatsapp_delivery_status(message_id);

-- Roll the latest delivery state onto messages for the dashboard.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_status_check
  CHECK (delivery_status IS NULL OR delivery_status IN ('accepted','sent','delivered','read','failed'));

CREATE OR REPLACE FUNCTION apply_wa_delivery_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE messages m
     SET delivery_status = NEW.status
   WHERE (NEW.message_id IS NOT NULL AND m.id = NEW.message_id)
      OR (NEW.message_id IS NULL AND m.wa_message_id = NEW.wa_message_id AND m.direction = 'out');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wa_delivery_apply ON whatsapp_delivery_status;
CREATE TRIGGER trg_wa_delivery_apply
  AFTER INSERT ON whatsapp_delivery_status
  FOR EACH ROW EXECUTE FUNCTION apply_wa_delivery_status();

-- ===================== SESSION-WINDOW VIEW ===========================
--  Inside 24h of the contact's last inbound message, free-form text is
--  allowed; outside it, only approved templates.

CREATE OR REPLACE VIEW v_wa_session_open
WITH (security_invoker = true) AS
SELECT c.person_id, p.name, c.wa_id, c.opt_in_status,
       c.last_inbound_at,
       (c.opt_in_status = 'opted_in'
        AND c.last_inbound_at IS NOT NULL
        AND c.last_inbound_at > now() - interval '24 hours') AS session_open
FROM whatsapp_contacts c
JOIN people p ON p.id = c.person_id
WHERE p.active = 1;

-- ========================= ROW LEVEL SECURITY ========================

ALTER TABLE whatsapp_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_contacts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_webhook_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_delivery_status ENABLE ROW LEVEL SECURITY;

-- Admin reads. Accounts hold only secret NAMES, but keep them admin-only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_accounts','whatsapp_contacts',
                           'whatsapp_webhook_events','whatsapp_delivery_status'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_admin_read ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_admin_read ON %I FOR SELECT TO authenticated
         USING (app_is_admin())', t, t);
  END LOOP;
END $$;

-- Admin manages accounts and contacts from the dashboard.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_accounts','whatsapp_contacts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_admin_write ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_admin_write ON %I FOR ALL TO authenticated
         USING (app_is_admin()) WITH CHECK (app_is_admin())', t, t);
  END LOOP;
END $$;

-- Staff can see their own connection state (not the event log).
DROP POLICY IF EXISTS wa_contacts_self_read ON whatsapp_contacts;
CREATE POLICY wa_contacts_self_read ON whatsapp_contacts
  FOR SELECT TO authenticated
  USING (person_id = app_current_person_id());

-- ====================== RECORD AS APPLIED ============================

-- Also record the repo-native copy's name so `npm run migrate` skips it.
INSERT INTO schema_migrations (filename)
VALUES ('20260901000003_whatsapp_connections.sql')
ON CONFLICT (filename) DO NOTHING;
