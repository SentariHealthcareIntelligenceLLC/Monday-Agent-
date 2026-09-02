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
    const row = await db.one(
      `INSERT INTO whatsapp_webhook_events
         (event_type, wa_message_id, wa_id, payload, signature_ok, processed_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (wa_message_id, event_type) WHERE wa_message_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [eventType, waMessageId || null, waId || null, JSON.stringify(payload || {}), signatureOk ?? null]);
    return Boolean(row);
  }, true);
}

/** An inbound message proves the number is live: opt in + open the 24h window. */
async function touchInbound(waId, profileName, personId) {
  return safe('touchInbound', async () => {
    await db.run(
      `INSERT INTO whatsapp_contacts (person_id, wa_id, profile_name, opt_in_status,
                                      opted_in_at, verified_at, last_inbound_at)
       VALUES ($1, $2, $3, 'opted_in', now(), now(), now())
       ON CONFLICT (wa_id) DO UPDATE SET
         profile_name    = COALESCE(EXCLUDED.profile_name, whatsapp_contacts.profile_name),
         opt_in_status   = 'opted_in',
         opted_in_at     = COALESCE(whatsapp_contacts.opted_in_at, now()),
         verified_at     = COALESCE(whatsapp_contacts.verified_at, now()),
         last_inbound_at = now(),
         failure_count   = 0,
         last_error      = NULL`,
      [personId || null, waId, profileName || null]);
  });
}

async function touchOutbound(waId) {
  return safe('touchOutbound', () => db.run(
    `UPDATE whatsapp_contacts SET last_outbound_at = now() WHERE wa_id = $1`, [waId]));
}

async function recordFailure(waId, error) {
  return safe('recordFailure', () => db.run(
    `UPDATE whatsapp_contacts
        SET failure_count = failure_count + 1, last_error = $2 WHERE wa_id = $1`,
    [waId, String(error).slice(0, 500)]));
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
      `INSERT INTO whatsapp_delivery_status (wa_message_id, status, error_code, error_detail)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wa_message_id, status) DO NOTHING`,
      [status.id, status.status, status.errors?.[0]?.code ? String(status.errors[0].code) : null, err]);
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
  getAccount, recordWebhookEvent, touchInbound, touchOutbound,
  recordFailure, recordDeliveryStatus, sessionOpen,
};
