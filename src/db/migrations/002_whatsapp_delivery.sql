-- 002: make the WhatsApp round trip work against live Meta traffic.
--
-- Three things the first cut did not account for:
--   1. Meta retries a webhook until it sees a 200, so the same reply can
--      arrive several times and must not complete a task twice.
--   2. A reply can be a photo rather than text, and photo proof needs an
--      object key on the message and a way to know which run it belongs to.
--   3. Numbers were stored exactly as a human typed them ("+1 (818) 555-0142")
--      but Meta identifies a sender as bare digits ("18185550142"), so inbound
--      replies matched nobody.
--
-- Postgres/Supabase only; additive, and safe against a database with live data.

-- ------------------------------------------------------------- new columns
ALTER TABLE people   ADD COLUMN IF NOT EXISTS awaiting_photo_run_id bigint;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_path text;

-- --------------------------------------------------------------- idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_wa_in
  ON messages(wa_message_id) WHERE direction = 'in' AND wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_wa_out
  ON messages(wa_message_id) WHERE direction = 'out';
CREATE INDEX IF NOT EXISTS idx_msg_person ON messages(person_id, created_at);

-- ------------------------------------------------- normalize stored numbers
-- Rewrites each number to the E.164 digits Meta sends. Only rows that actually
-- change are touched.
--
-- people.whatsapp_number is UNIQUE, so a rewrite must not create a duplicate —
-- and there are two ways it could. The number might already be held by another
-- row, or two rows being rewritten together might normalize onto each other
-- ("8185550143" and "(818) 555-0143"). Both are guarded: the first by NOT
-- EXISTS, the second by keeping only the lowest id per normalized value.
--
-- A skipped row keeps its original text and simply will not match an inbound
-- reply, which is visible and fixable from the dashboard. That is the right
-- trade against aborting the whole migration — a genuine duplicate is a data
-- problem for a human to resolve, not something to guess at here.
WITH normalized AS (
  SELECT id,
         whatsapp_number AS was,
         CASE
           WHEN length(regexp_replace(whatsapp_number, '\D', '', 'g')) = 10
             THEN '1' || regexp_replace(whatsapp_number, '\D', '', 'g')
           ELSE regexp_replace(whatsapp_number, '\D', '', 'g')
         END AS now_
    FROM people
   WHERE whatsapp_number IS NOT NULL AND whatsapp_number <> ''
),
candidates AS (
  SELECT id, was, now_,
         row_number() OVER (PARTITION BY now_ ORDER BY id) AS rn
    FROM normalized
   WHERE now_ <> was
     AND length(now_) BETWEEN 8 AND 15
)
UPDATE people p
   SET whatsapp_number = c.now_
  FROM candidates c
 WHERE p.id = c.id
   AND c.rn = 1
   AND NOT EXISTS (SELECT 1 FROM people o WHERE o.whatsapp_number = c.now_ AND o.id <> c.id);
