-- =====================================================================
--  Migration 007 — Delivery status must not go backwards
--
--  Meta's receipt callbacks are not ordered. apply_wa_delivery_status()
--  copied every newly seen status onto messages.delivery_status
--  unconditionally, so a late 'sent' or 'delivered' callback arriving
--  after 'read' regressed the message to an earlier state and the
--  dashboard showed a read message as merely sent.
--
--  The lifecycle is monotonic, so rank it and only move forward:
--    accepted < sent < delivered < read < failed
--  'failed' ranks highest deliberately: a delivery failure is the most
--  actionable state and must never be masked by an earlier receipt.
--
--  whatsapp_delivery_status rows keep every receipt, so the audit trail is
--  unchanged; only the rollup is guarded. recordDeliveryStatus() now also
--  persists Meta's own event timestamp in occurred_at instead of leaving
--  the insertion-time default, so the ordering is visible in the data.
--
--  Idempotent; safe to re-run.
-- =====================================================================

CREATE OR REPLACE FUNCTION wa_delivery_rank(s text)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE s
           WHEN 'accepted'  THEN 1
           WHEN 'sent'      THEN 2
           WHEN 'delivered' THEN 3
           WHEN 'read'      THEN 4
           WHEN 'failed'    THEN 5
           ELSE 0
         END
$$;

REVOKE ALL ON FUNCTION wa_delivery_rank(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION wa_delivery_rank(text) TO authenticated;

CREATE OR REPLACE FUNCTION apply_wa_delivery_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE messages m
     SET delivery_status = NEW.status
   WHERE ((NEW.message_id IS NOT NULL AND m.id = NEW.message_id)
       OR (NEW.message_id IS NULL AND m.wa_message_id = NEW.wa_message_id
           AND m.direction = 'out'))
     AND wa_delivery_rank(NEW.status) > wa_delivery_rank(COALESCE(m.delivery_status, ''));
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION apply_wa_delivery_status() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_wa_delivery_apply ON whatsapp_delivery_status;
CREATE TRIGGER trg_wa_delivery_apply
  AFTER INSERT ON whatsapp_delivery_status
  FOR EACH ROW EXECUTE FUNCTION apply_wa_delivery_status();
