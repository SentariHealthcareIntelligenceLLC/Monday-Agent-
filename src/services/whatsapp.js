'use strict';
/**
 * WhatsApp Business Cloud API (Meta) client.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Two ways to send:
 *  - sendTemplate(): required to OPEN a conversation (outside the 24h window).
 *  - sendText():     allowed only INSIDE the 24h customer-service window,
 *                    i.e. after the person has messaged you.
 * The reminder jobs use templates; replies are answered with plain text.
 */
const crypto = require('crypto');
const config = require('../config');
const waConn = require('./waConnections');
const logger = require('../logger');
const { db } = require('../db');

const graph = (p) => `https://graph.facebook.com/${config.whatsapp.apiVersion}/${p}`;
const base = () => graph(`${config.whatsapp.phoneNumberId}/messages`);

async function logMessage(row) {
  const r = {
    direction: 'out', channel: 'wa', person_id: null, wa_number: null, wa_message_id: null,
    body: null, kind: null, task_run_id: null, media_path: null, status: null, error: null, ...row,
  };
  await db.run(
    `INSERT INTO messages
       (direction, channel, person_id, wa_number, wa_message_id, body, kind, task_run_id,
        media_path, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [r.direction, r.channel, r.person_id, r.wa_number, r.wa_message_id, r.body,
     r.kind, r.task_run_id, r.media_path, r.status, r.error]
  );
}

/**
 * Record an inbound message, returning false if Meta has already delivered it.
 *
 * Meta retries a webhook until it receives a 200, and a retry carries the same
 * message id. Without this check a redelivered "DONE 2" completes a second
 * task. The unique index does the deciding, so two concurrent deliveries of
 * the same message cannot both win.
 */
async function logInbound(row) {
  if (!row.wa_message_id) {
    await logMessage({ ...row, direction: 'in' });
    return true;
  }
  const seen = await db.one(
    `SELECT id FROM messages WHERE direction = 'in' AND wa_message_id = $1`,
    [row.wa_message_id]
  );
  if (seen) {
    logger.info({ wa_message_id: row.wa_message_id }, 'Duplicate webhook delivery ignored');
    return false;
  }
  try {
    await logMessage({ ...row, direction: 'in' });
    return true;
  } catch (err) {
    // Lost the race against a concurrent delivery of the same message.
    logger.info({ err: String(err) }, 'Concurrent duplicate inbound ignored');
    return false;
  }
}

/**
 * Attach a stored photo to the inbound row already logged for that message,
 * rather than logging the same message twice under two kinds.
 */
async function attachMedia(waMessageId, { mediaPath, taskRunId }) {
  if (!waMessageId) return;
  await db.run(
    `UPDATE messages SET media_path = $1, task_run_id = $2, kind = 'proof'
      WHERE direction = 'in' AND wa_message_id = $3`,
    [mediaPath, taskRunId, waMessageId]
  );
}

/**
 * Apply a delivery receipt (sent -> delivered -> read, or failed) to the
 * outbound row it belongs to. This is how the dashboard can say a reminder
 * actually landed rather than merely left.
 */
async function applyStatus(status) {
  const id = status?.id;
  if (!id || !status.status) return;
  await db.run(
    `UPDATE messages SET status = $1, error = COALESCE($2, error)
      WHERE direction = 'out' AND wa_message_id = $3`,
    [status.status, status.errors ? JSON.stringify(status.errors) : null, id]
  );
}

async function post(payload, meta = {}) {
  if (config.dryRun || !config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    logger.info({ payload }, 'DRY_RUN: WhatsApp message not sent');
    await logMessage({ ...meta, wa_number: payload.to, body: JSON.stringify(payload), status: 'dry_run' });
    return { dryRun: true };
  }
  try {
    const res = await fetch(base(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      logger.error({ status: res.status, json }, 'WhatsApp send failed');
      await logMessage({ ...meta, wa_number: payload.to, body: JSON.stringify(payload), status: 'failed', error: JSON.stringify(json) });
      await waConn.recordFailure(payload.to, json);
      return { error: json };
    }
    await logMessage({
      ...meta, wa_number: payload.to, body: JSON.stringify(payload),
      wa_message_id: json.messages?.[0]?.id, status: 'sent',
    });
    await waConn.touchOutbound(payload.to);
    return json;
  } catch (err) {
    logger.error({ err }, 'WhatsApp send threw');
    await logMessage({ ...meta, wa_number: payload.to, body: JSON.stringify(payload), status: 'failed', error: String(err) });
    await waConn.recordFailure(payload.to, err);
    return { error: String(err) };
  }
}

/** Send an approved template message. params = array of body variable strings. */
function sendTemplate(to, templateName, params = [], meta = {}) {
  return post({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: config.whatsapp.templates.lang },
      components: params.length
        ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }]
        : [],
    },
  }, meta);
}

/** Free-form text. Only valid inside the 24-hour window. */
function sendText(to, body, meta = {}) {
  return post({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body },
  }, meta);
}

/**
 * Download an inbound media object (a photo proof) from Meta.
 *
 * Two hops, both authenticated: the media id resolves to a short-lived URL on
 * a Meta CDN, and that URL still needs the bearer token. Returns the bytes and
 * their content type so storage can name the object correctly.
 */
async function fetchMedia(mediaId) {
  if (!config.whatsapp.token) throw new Error('WHATSAPP_TOKEN is not set');
  const auth = { Authorization: `Bearer ${config.whatsapp.token}` };

  const metaRes = await fetch(graph(mediaId), { headers: auth });
  if (!metaRes.ok) {
    throw new Error(`media lookup failed (${metaRes.status})`);
  }
  const { url, mime_type: mimeType } = await metaRes.json();
  if (!url) throw new Error('media lookup returned no url');

  const binRes = await fetch(url, { headers: auth });
  if (!binRes.ok) throw new Error(`media download failed (${binRes.status})`);

  const buffer = Buffer.from(await binRes.arrayBuffer());
  // Meta appends codec parameters to some types ("image/jpeg; charset=..."),
  // which would not match the storage type table.
  return { buffer, contentType: String(mimeType || '').split(';')[0].trim() };
}

/** Verify Meta's X-Hub-Signature-256 header against the raw request body. */
function verifySignature(rawBody, signatureHeader) {
  if (!config.whatsapp.appSecret) return true; // not configured -> skip (dev only)
  if (!signatureHeader) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  sendTemplate, sendText, verifySignature, logMessage, logInbound, applyStatus, fetchMedia,
  attachMedia,
};
