'use strict';
const config = require('../config');
const logger = require('../logger');
const wa = require('../services/whatsapp');
const T = require('../services/tasks');
const { parseReply } = require('../services/replies');

function register(app, path = '/webhook/whatsapp') {
  // --- 1. Verification handshake (Meta calls this once when you subscribe) ---
  app.get(path, (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
      logger.info('Webhook verified by Meta');
      return res.text(challenge, 200);
    }
    return res.text('forbidden', 403);
  });

  // --- 2. Inbound messages ---
  app.post(path, async (req, res) => {
    if (!wa.verifySignature(req.rawBody || Buffer.alloc(0), req.headers['x-hub-signature-256'])) {
      logger.warn('Rejected webhook: bad signature');
      return res.text('unauthorized', 401);
    }
    res.text('EVENT_RECEIVED', 200); // ack immediately; Meta retries on non-200

    try {
      for (const entry of req.body.entry || []) {
        for (const change of entry.changes || []) {
          for (const msg of change.value?.messages || []) {
            await handleMessage(msg);
          }
        }
      }
    } catch (err) {
      logger.error({ err: String(err) }, 'Webhook processing failed');
    }
  });
}

async function handleMessage(msg) {
  const from = msg.from;
  const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '';
  const person = T.personByNumber(from);

  wa.logMessage({
    direction: 'in', person_id: person?.id || null, wa_number: from,
    wa_message_id: msg.id, body: text, kind: 'reply', status: 'received',
  });

  if (!person) {
    return wa.sendText(from, 'This number is not registered with QCMS task management. Please contact your manager.');
  }

  const open = T.openRunsForPerson(person.id);
  const listText = open.length
    ? open.map((r, i) => `${i + 1}. ${r.title} (due ${r.due_date} ${r.due_time})`).join('\n')
    : 'Nothing open — you are all caught up. 👍';

  const { action, index, note } = parseReply(text);

  switch (action) {
    case 'list':
      return wa.sendText(from, `Your open tasks:\n${listText}`, { person_id: person.id, kind: 'ack' });

    case 'help':
      return wa.sendText(from,
        'QCMS task bot commands:\n' +
        'LIST — show your open tasks\n' +
        'DONE <number> [note] — mark complete\n' +
        'BLOCKED <number> <reason> — flag a blocker\n' +
        'SNOOZE <number> — push to later today',
        { person_id: person.id, kind: 'ack' });

    case 'done':
    case 'blocked':
    case 'snoozed': {
      if (!open.length) {
        return wa.sendText(from, 'You have no open tasks right now.', { person_id: person.id, kind: 'ack' });
      }
      let target = null;
      if (index && open[index - 1]) target = open[index - 1];
      else if (open.length === 1) target = open[0];

      if (!target) {
        return wa.sendText(from,
          `Which one? Reply ${action.toUpperCase()} <number>:\n${listText}`,
          { person_id: person.id, kind: 'ack' });
      }
      if (action === 'blocked' && !note) {
        return wa.sendText(from, `Got it — what is blocking "${target.title}"? Reply BLOCKED ${index || 1} <reason>.`,
          { person_id: person.id, kind: 'ack' });
      }
      T.markRun(target.id, action, note);

      if (action === 'blocked') {
        const [boss] = T.chainOfCommand(person.id);
        if (boss?.whatsapp_number) {
          await wa.sendText(boss.whatsapp_number,
            `⚠️ ${person.name} flagged a blocker on "${target.title}" (due ${target.due_date}): ${note}`,
            { person_id: boss.id, kind: 'escalation', task_run_id: target.id });
        }
      }
      const verb = { done: 'marked complete ✅', blocked: 'flagged as blocked ⚠️', snoozed: 'snoozed ⏱' }[action];
      const remaining = T.openRunsForPerson(person.id).length;
      return wa.sendText(from,
        `"${target.title}" ${verb}. ${remaining ? `${remaining} task(s) still open — reply LIST to see them.` : 'Nothing else open today.'}`,
        { person_id: person.id, kind: 'ack', task_run_id: target.id });
    }

    default:
      return wa.sendText(from,
        `I didn't catch that. Reply HELP for commands.\nYour open tasks:\n${listText}`,
        { person_id: person.id, kind: 'ack' });
  }
}

module.exports = { register, handleMessage };
