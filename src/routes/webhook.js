'use strict';
const config = require('../config');
const logger = require('../logger');
const wa = require('../services/whatsapp');
const T = require('../services/tasks');
const storage = require('../services/storage');
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
          // Delivery receipts for messages we sent, and replies people sent us,
          // arrive through the same subscription.
          for (const status of change.value?.statuses || []) {
            await wa.applyStatus(status);
          }
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
  // A photo can carry its instruction in the caption ("done 2"), so captions
  // are parsed exactly like a text body.
  const text = msg.text?.body
    || msg.image?.caption
    || msg.button?.text
    || msg.interactive?.button_reply?.title
    || '';
  const person = await T.personByNumber(from);

  const first = await wa.logInbound({
    person_id: person?.id || null, wa_number: from,
    wa_message_id: msg.id, body: text, kind: 'reply', status: 'received',
  });
  // A Meta retry of a message already handled must not act on it twice.
  if (!first) return undefined;

  if (!person) {
    logger.warn({ from }, 'Inbound WhatsApp from an unregistered number');
    return wa.sendText(from, 'This number is not registered with QCMS task management. Please contact your manager.');
  }

  // ---- photo proof -------------------------------------------------------
  // An image completes whichever run the person was last asked to prove, or
  // their only open run if they simply sent a photo without saying DONE.
  if (msg.type === 'image' && msg.image?.id) {
    return handlePhoto(msg, person, text);
  }

  const open = await T.openRunsForPerson(person.id);
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
      // A task that requires photo proof is not complete on a word alone —
      // it stays open until the picture arrives.
      if (action === 'done' && Number(target.requires_photo) === 1 && !target.photo_path) {
        await T.setAwaitingPhoto(person.id, target.id);
        return wa.sendText(from,
          `Almost — "${target.title}" needs a photo. Send the picture as your next message and I'll mark it complete.`,
          { person_id: person.id, kind: 'ack', task_run_id: target.id });
      }

      await T.markRun(target.id, action, note);
      if (action !== 'done') await T.clearAwaitingPhoto(person.id);

      if (action === 'blocked') {
        const [boss] = await T.chainOfCommand(person.id);
        if (boss?.whatsapp_number) {
          await wa.sendText(boss.whatsapp_number,
            `⚠️ ${person.name} flagged a blocker on "${target.title}" (due ${target.due_date}): ${note}`,
            { person_id: boss.id, kind: 'escalation', task_run_id: target.id });
        }
      }
      const verb = { done: 'marked complete ✅', blocked: 'flagged as blocked ⚠️', snoozed: 'snoozed ⏱' }[action];
      const remaining = (await T.openRunsForPerson(person.id)).length;
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

/**
 * An inbound image: download it from Meta, put it in the proof bucket, and
 * attach it to the run it belongs to — completing that run, since the photo is
 * the completion.
 */
async function handlePhoto(msg, person, caption) {
  const open = await T.openRunsForPerson(person.id);

  // Which run is this proof for? In order: the one we explicitly asked for,
  // a number given in the caption ("done 2"), or the only thing open.
  let target = null;
  if (person.awaiting_photo_run_id) {
    target = await T.runById(person.awaiting_photo_run_id);
  }
  if (!target) {
    const { index } = parseReply(caption);
    if (index && open[index - 1]) target = open[index - 1];
    else if (open.length === 1) target = open[0];
  }

  if (!target) {
    return wa.sendText(person.whatsapp_number,
      open.length
        ? `Thanks — which task is that photo for? Reply DONE <number>:\n${
            open.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}`
        : 'Thanks — but you have no open tasks needing a photo right now.',
      { person_id: person.id, kind: 'ack' });
  }

  let key;
  try {
    const { buffer, contentType } = await wa.fetchMedia(msg.image.id);
    key = await storage.put('run', target.id, buffer, contentType);
  } catch (err) {
    logger.error({ err: String(err), run: target.id }, 'Photo proof failed');
    // The run stays open and the person is still marked as owing a photo, so
    // a retry lands on the same task rather than being lost.
    return wa.sendText(person.whatsapp_number,
      `I couldn't save that photo for "${target.title}". Please try sending it again.`,
      { person_id: person.id, kind: 'ack', task_run_id: target.id });
  }

  await T.setPhoto(target.id, key);
  await T.markRun(target.id, 'done', caption || null);
  await T.clearAwaitingPhoto(person.id);
  await wa.attachMedia(msg.id, { mediaPath: key, taskRunId: target.id });

  const remaining = (await T.openRunsForPerson(person.id)).length;
  return wa.sendText(person.whatsapp_number,
    `Photo received — "${target.title}" marked complete ✅. ${
      remaining ? `${remaining} task(s) still open — reply LIST to see them.` : 'Nothing else open today.'}`,
    { person_id: person.id, kind: 'ack', task_run_id: target.id });
}

module.exports = { register, handleMessage, handlePhoto };
