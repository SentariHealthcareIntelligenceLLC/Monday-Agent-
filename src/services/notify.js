'use strict';
/**
 * Channel-aware delivery. Jobs say "tell this person X"; this decides whether
 * that means WhatsApp, email, or both, based on the person's `channel` column
 * with the global CHANNEL default as a fallback.
 *
 * WhatsApp templates are still required to OPEN a conversation outside Meta's
 * 24-hour window, so `notifyTemplate` exists separately from `notifyText`.
 */
const config = require('../config');
const logger = require('../logger');
const wa = require('./whatsapp');
const { sendEmail } = require('./email');

const wants = (person, which) => {
  const c = person.channel || config.defaultChannel || 'wa';
  return c === which || c === 'both';
};

const canWhatsApp = (p) => Boolean(p.whatsapp_number) && wants(p, 'wa');
const canEmail = (p) => Boolean(p.email || p.person_email) && wants(p, 'em');

const addressOf = (p) => p.email || p.person_email;
const nameOf = (p) => p.name || p.person_name || 'there';

/**
 * Free-form text. WhatsApp only accepts this inside the 24h window; email has
 * no such limit, so email is the more reliable half of a `both` send.
 */
async function notifyText(person, subject, body, meta = {}) {
  const sent = [];
  if (canWhatsApp(person)) {
    await wa.sendText(person.whatsapp_number, body, { ...meta, channel: 'wa' });
    sent.push('wa');
  }
  if (canEmail(person)) {
    await sendEmail(addressOf(person), subject, body, { ...meta, channel: 'em' });
    sent.push('em');
  }
  if (!sent.length) {
    logger.warn({ person: nameOf(person) }, 'No usable channel for person; skipped');
  }
  return sent;
}

/** Template send (opens a WhatsApp conversation); email gets the plain text. */
async function notifyTemplate(person, templateName, params, subject, body, meta = {}) {
  const sent = [];
  if (canWhatsApp(person)) {
    await wa.sendTemplate(person.whatsapp_number, templateName, params, { ...meta, channel: 'wa' });
    sent.push('wa');
  }
  if (canEmail(person)) {
    await sendEmail(addressOf(person), subject, body, { ...meta, channel: 'em' });
    sent.push('em');
  }
  if (!sent.length) {
    logger.warn({ person: nameOf(person) }, 'No usable channel for person; skipped');
  }
  return sent;
}

module.exports = { notifyText, notifyTemplate, canWhatsApp, canEmail };
