'use strict';
/**
 * Email channel, alongside WhatsApp. Uses the Resend HTTP API over fetch so
 * the service keeps a single npm dependency and no SMTP stack.
 *
 * Honours the same DRY_RUN switch as WhatsApp: with it on, mail is written to
 * the messages table and never sent.
 */
const config = require('../config');
const logger = require('../logger');
const { db } = require('../db');

async function logMessage(row) {
  const r = {
    direction: 'out', channel: 'em', person_id: null, wa_number: null, wa_message_id: null,
    body: null, kind: null, task_run_id: null, status: null, error: null, ...row,
  };
  await db.run(
    `INSERT INTO messages
       (direction, channel, person_id, wa_number, wa_message_id, body, kind, task_run_id, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [r.direction, r.channel, r.person_id, r.wa_number, r.wa_message_id, r.body,
     r.kind, r.task_run_id, r.status, r.error]
  );
}

const configured = () => Boolean(config.email.apiKey && config.email.from);

async function sendEmail(to, subject, text, meta = {}) {
  const body = `${subject}\n\n${text}`;

  if (config.dryRun || !configured()) {
    logger.info({ to, subject }, 'DRY_RUN: email not sent');
    await logMessage({ ...meta, wa_number: to, body, status: 'dry_run' });
    return { dryRun: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, text }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error({ status: res.status, json }, 'Email send failed');
      await logMessage({ ...meta, wa_number: to, body, status: 'failed', error: JSON.stringify(json) });
      return { error: json };
    }
    await logMessage({ ...meta, wa_number: to, body, wa_message_id: json.id, status: 'sent' });
    return json;
  } catch (err) {
    logger.error({ err: String(err) }, 'Email send threw');
    await logMessage({ ...meta, wa_number: to, body, status: 'failed', error: String(err) });
    return { error: String(err) };
  }
}

module.exports = { sendEmail, configured, logMessage };
