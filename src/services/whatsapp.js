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
const logger = require('../logger');
const { db } = require('../db');

const base = () =>
  `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

async function logMessage(row) {
  const r = {
    direction: 'out', channel: 'wa', person_id: null, wa_number: null, wa_message_id: null,
    body: null, kind: null, task_run_id: null, status: null, error: null, ...row,
  };
  await db.run(
    `INSERT INTO messages
       (direction, channel, person_id, wa_number, wa_message_id, body, kind, task_run_id, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [r.direction, r.channel, r.person_id, r.wa_number, r.wa_message_id, r.body,
     r.kind, r.task_run_id, r.status, r.error]
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
      return { error: json };
    }
    await logMessage({
      ...meta, wa_number: payload.to, body: JSON.stringify(payload),
      wa_message_id: json.messages?.[0]?.id, status: 'sent',
    });
    return json;
  } catch (err) {
    logger.error({ err }, 'WhatsApp send threw');
    await logMessage({ ...meta, wa_number: payload.to, body: JSON.stringify(payload), status: 'failed', error: String(err) });
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

module.exports = { sendTemplate, sendText, verifySignature, logMessage };
