'use strict';
/**
 * WhatsApp connection state (migration 004 / 20260901000003).
 *
 * Keeps the tables that stop the dashboard going stale:
 *   whatsapp_accounts        — sender config; secrets live in Supabase Vault,
 *                              this resolves them at runtime (env vars remain
 *                              the fallback, so nothing breaks before setup)
 *   whatsapp_contacts        — per-person opt-in + last inbound/outbound,
 *                              which drives the 24h session window
 *   whatsapp_webhook_events  — raw inbound audit log, deduped
 *   whatsapp_delivery_status — sent/delivered/read/failed receipts; a DB
 *                              trigger rolls the latest onto messages
 *
 * Postgres-only (Supabase). Every function no-ops safely on the SQLite
 * backend or when the tables don't exist yet, so wiring this in cannot
 * take the webhook down.
 */
const config = require('../config');
const logger = require('../logger');
const { db, backend } = require('../db');

const enabled = () => backend.kind === 'postgres';

async function safe(name, fn, fallback = undefined) {
  if (!enabled()) return fallback;
  try {
    return await fn();
  } catch (err) {
    // e.g. tables not migrated yet — degrade, never throw into the webhook.
    logger.warn({ err: String(err) }, `waConnections.${name} skipped`);
    return fallback;
  }
}

/**
 * Resolve the active sender. DB row (with Vault secrets) when configured;
 * env vars otherwise. Shape matches config.whatsapp so callers can swap it in.
 */
async function getAccount() {
  const fromEnv = {
    source: 'env',
    phoneNumberId: config.whatsapp.phoneNumberId,
    token: config.whatsapp.token,
    appSecret: config.whatsapp.appSecret,
    verifyToken: config.whatsapp.verifyToken,
    apiVersion: config.whatsapp.apiVersion,
    templates: config.whatsapp.templates,
  };
  return safe('getAccount', async () => {
    const acct = await db.one(
      `SELECT * FROM whatsapp_accounts WHERE active AND status <> 'disabled'
        ORDER BY id LIMIT 1`);
    if (!acct) return fromEnv;
    const secret = async (name) => {
      if (!name) return null;
      const row = await db.one(
        'SELECT decrypted_secret AS v FROM vault.decrypted_secrets WHERE name = $1', [name]);
      return row ? row.v : null;
    };
    const token = await secret(acct.token_secret_name);
    if (!token) return fromEnv; // Vault not populated yet — env still rules
    return {
      source: 'db',
      accountId: acct.id,
      phoneNumberId: acct.phone_number_id,
      token,
      appSecret: (await secret(acct.app_secret_name)) || config.whatsapp.appSecret,
      verifyToken: (await secret(acct.verify_token_name)) || config.whatsapp.verifyToken,
      apiVersion: acct.api_version,
      templates: {
        taskReminder: acct.template_reminder,
        escalation: acct.template_escalation,
        lang: acct.template_lang,
      },
    };
  }, fromEnv);
}

/** Log one raw webhook entry. Returns false when it's a Meta redelivery. */
async function recordWebhookEvent({ eventType, waMessageId, waId, payload, signatureOk }) {
  return safe('recordWebhookEvent', async () => {
    // processed_at is deliberately left NULL here and stamped only after the
    // message is actually handled. Marking it at insert time meant that a
    // crash or a throw inside handleMessage() left the event looking done, so
    // Meta's redelivery was skipped and the reply -- a DONE, or a photo proof
    // -- was lost for good. Dedupe is therefore "already handled", not
    // "already seen": a redelivery of an unprocessed event is handled again,
    // which is the safe direction for an idempotent command.
    const row = await db.one(
      `INSERT INTO whatsapp_webhook_events
         (event_type, wa_message_id, wa_id, payload, signature_ok)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wa_message_id, event_type) WHERE wa_message_id IS NOT NULL
       DO UPDATE SET received_at = now()
       RETURNING processed_at`,
      [eventType, waMessageId || null, waId || null, JSON.stringify(payload || {}), signatureOk ?? null]);
    return !row || row.processed_at === null;
  }, true);
}

/** Stamp an event handled, so a later Meta redelivery of it is skipped. */
async function markEventProcessed(waMessageId, eventType) {
  if (!waMessageId) return;
  return safe('markEventProcessed', () => db.run(
    `UPDATE whatsapp_webhook_events SET processed_at = now()
      WHERE wa_message_id = $1 AND event_type = $2 AND processed_at IS NULL`,
    [waMessageId, eventType || 'message']));
}

/**
 * Resolve which active person owns a number, per `people` — the source of
 * truth. An explicit personId from the caller wins.
 */
async function resolvePersonId(waId, personId) {
  if (personId) return personId;
  const r = await db.all(
    'SELECT id FROM people WHERE whatsapp_number = $1 AND active = 1 LIMIT 1', [waId]);
  return r[0]?.id;
}

/**
 * Guarantee that `person` owns exactly one contact row and that it is keyed to
 * `waId`, then return true.
 *
 * Two constraints make this fiddly: whatsapp_contacts is UNIQUE on wa_id AND
 * UNIQUE on person_id. So a naive keyed-by-number upsert goes wrong in two
 * ways an admin can trigger just by editing people.whatsapp_number:
 *
 *   - the person already has a row under their previous number, so inserting
 *     collides on person_id;
 *   - the number was reassigned to someone else, so a stale row still claims
 *     this wa_id for its previous owner. Updating by wa_id alone would then
 *     record this person's opt-in, session window and profile name against
 *     THAT person -- a cross-person mix-up, not just lost state.
 *
 * `people` decides who owns a number now, so a contradicting row is stale: it
 * is repointed to its owner's current number when that is free, and removed
 * when it is not (the row holds only connection state, all of it rederivable
 * from the next message). Either way it is logged, because silently moving
 * rows between people is exactly the kind of thing that should be visible.
 */
async function ensureContact(waId, pid) {
  const stale = (await db.all(
    'SELECT id, person_id FROM whatsapp_contacts WHERE wa_id = $1 AND person_id <> $2',
    [waId, pid]))[0];

  if (stale) {
    const owner = (await db.all(
      'SELECT whatsapp_number FROM people WHERE id = $1', [stale.person_id]))[0];
    const current = owner?.whatsapp_number;
    const free = current && current !== waId && (await db.all(
      'SELECT 1 FROM whatsapp_contacts WHERE wa_id = $1', [current])).length === 0;

    if (free) {
      await db.run('UPDATE whatsapp_contacts SET wa_id = $2 WHERE id = $1', [stale.id, current]);
    } else {
      await db.run('DELETE FROM whatsapp_contacts WHERE id = $1', [stale.id]);
    }
    logger.warn({ waId, stalePersonId: stale.person_id, personId: pid, repointed: !!free },
      'whatsapp contact row no longer matches people.whatsapp_number; reassigned');
  }

  // The person may hold a row under an older number: repoint it.
  const moved = await db.run(
    'UPDATE whatsapp_contacts SET wa_id = $2 WHERE person_id = $1 AND wa_id <> $2', [pid, waId]);
  if (moved) return true;

  await db.run(
    `INSERT INTO whatsapp_contacts (person_id, wa_id, opt_in_status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (person_id) DO NOTHING`, [pid, waId]);
  return true;
}

/** An inbound message proves the number is live: opt in + open the 24h window. */
async function touchInbound(waId, profileName, personId) {
  return safe('touchInbound', async () => {
    const pid = await resolvePersonId(waId, personId);
    if (!pid) {
      logger.warn({ waId }, 'touchInbound: no active person for number; contact not recorded');
      return;
    }
    await ensureContact(waId, pid);
    await db.run(
      `UPDATE whatsapp_contacts SET
         profile_name    = COALESCE($2, profile_name),
         opt_in_status   = 'opted_in',
         opted_in_at     = COALESCE(opted_in_at, now()),
         verified_at     = COALESCE(verified_at, now()),
         last_inbound_at = now(),
         failure_count   = 0,
         last_error      = NULL
       WHERE person_id = $1`,
      [pid, profileName || null]);
  });
}

/**
 * A send is often the FIRST thing that happens to a person added after
 * migration 004's one-time backfill, so this creates the contact row rather
 * than assuming one exists — otherwise the connections dashboard shows no
 * outbound timestamp for exactly the people who were just onboarded.
 */
async function touchOutbound(waId) {
  return safe('touchOutbound', async () => {
    const pid = await resolvePersonId(waId, null);
    if (!pid) {
      return db.run(
        'UPDATE whatsapp_contacts SET last_outbound_at = now() WHERE wa_id = $1', [waId]);
    }
    await ensureContact(waId, pid);
    return db.run(
      'UPDATE whatsapp_contacts SET last_outbound_at = now() WHERE person_id = $1', [pid]);
  });
}

/** Same first-send reasoning as touchOutbound: the row may not exist yet. */
async function recordFailure(waId, error) {
  return safe('recordFailure', async () => {
    const detail = String(error).slice(0, 500);
    const pid = await resolvePersonId(waId, null);
    if (!pid) {
      return db.run(
        `UPDATE whatsapp_contacts
            SET failure_count = failure_count + 1, last_error = $2 WHERE wa_id = $1`,
        [waId, detail]);
    }
    await ensureContact(waId, pid);
    return db.run(
      `UPDATE whatsapp_contacts
          SET failure_count = failure_count + 1, last_error = $2 WHERE person_id = $1`,
      [pid, detail]);
  });
}

/**
 * Store a delivery receipt. The trg_wa_delivery_apply trigger copies the
 * status onto the matching messages row, so the dashboard's Messages tab
 * shows delivered/read/failed without a second write path.
 */
async function recordDeliveryStatus(status) {
  if (!status?.id || !status.status) return;
  const err = status.errors ? JSON.stringify(status.errors) : null;
  return safe('recordDeliveryStatus', async () => {
    await db.run(
      `INSERT INTO whatsapp_delivery_status
         (wa_message_id, status, error_code, error_detail, occurred_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
       ON CONFLICT (wa_message_id, status) DO NOTHING`,
      [status.id, status.status, status.errors?.[0]?.code ? String(status.errors[0].code) : null, err,
        // Meta sends unix seconds as a string; keep its own event time rather
        // than the insertion default, so out-of-order receipts are visible.
        status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : null]);
    if (status.status === 'failed' && status.recipient_id) {
      await recordFailure(status.recipient_id, err || 'delivery failed');
    }
  });
}

/** Is free-form text allowed for this person right now (24h window open)? */
async function sessionOpen(personId) {
  return safe('sessionOpen', async () => {
    const row = await db.one(
      'SELECT session_open FROM v_wa_session_open WHERE person_id = $1', [personId]);
    return Boolean(row && row.session_open);
  }, false);
}

module.exports = {
  getAccount, recordWebhookEvent, markEventProcessed, touchInbound, touchOutbound,
  recordFailure, recordDeliveryStatus, sessionOpen,
};
